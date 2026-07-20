/**
 * Mavis Coder Agent — full agent loop with tool calling.
 *
 * Sprint B-2 + B-5. The LLM can call any of the registered tools (mavis_bash,
 * mavis_read, mavis_write, mavis_edit, mavis_search, mavis_git,
 * mavis_supabase, mavis_run_tests, mavis_state) iteratively until it
 * produces a final response or hits max_iterations.
 *
 * Sprint B-5 additions:
 *   - onProgress callback: emit structured events for each iteration
 *     and tool call. Wired to MCP logging notifications in the tool wrapper.
 *   - sessionWriter: persist events to JSONL file (flight recorder).
 *   - max_iterations default 20 (was 10).
 *   - Default system prompt for efficiency ("be terse, don't re-read,
 *     batch related edits, plan upfront").
 *
 * Design notes:
 *   - Pure function: takes (request, client, tools, executor, cfg, opts)
 *     and returns Promise<AgentResult<AgentResponse>>. No I/O outside
 *     the LLM API, the tool executor, and the optional session writer.
 *   - Think block stripping: <think>...</think> removed from content
 *     before adding to history. Prevents the model from "listening to
 *     itself" across iterations.
 *   - Tool recursion guard: by default, mavis_coder and mavis_coder_agent
 *     are NOT exposed to the LLM. Caller can opt in via req.tools.
 *   - Errors during a tool call don't crash the loop — they're recorded
 *     as is_error=true and sent back to the LLM as a tool message with
 *     an "Error: " prefix. The model can retry or take a different path.
 *   - Latency: hrtime.bigint() (monotonic) for both per-tool and total.
 *   - Token aggregation: we sum usage across all iterations. v1 doesn't
 *     truncate the context — long loops accumulate input tokens.
 */

import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall } from 'openai/resources/chat/completions';
import type OpenAI from 'openai';
import type {
    AgentRequest,
    AgentResponse,
    AgentResult,
    AgentTool,
    AgentToolCallRecord,
    CoderUsage,
    LlmConfig,
    ToolExecutor
} from './types.js';
import type { SessionEvent, SessionWriter } from './session-log.js';

const DEFAULT_MAX_ITERATIONS = 20; // Bump from 10 → 20 to avoid premature cap.
const HARD_MAX_ITERATIONS = 30;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const RESULT_SUMMARY_MAX_CHARS = 500;

/**
 * Default system prompt appended to the user prompt when none is
 * provided. Encourages efficiency (low iteration count) and clarity.
 * Can be overridden by req.system.
 */
const DEFAULT_SYSTEM_PROMPT = `You are a careful coding assistant. Be efficient:
- Plan your tool calls before invoking them. Don't re-read files you already have the content of.
- Batch related edits in the same iteration. If a task needs 3 file edits, do them in 1-2 iterations, not 5.
- Be terse in your final response. The caller already has the tool call history.
- Stop as soon as the task is done. Don't add extra polish unless asked.
- If a tool returns an error, try a different approach. Don't repeat the same failing call.`;

/**
 * Progress event emitted during the agent loop. The tool wrapper
 * wires this to MCP logging notifications; the session writer
 * persists it to JSONL.
 */
export interface AgentProgressEvent {
    session_id: string;
    event: SessionEvent;
}

/**
 * Strip <think>...</think> blocks from assistant content.
 * MiniMax-M3 is a reasoning model and emits these before its real
 * response. We keep them out of the message history to avoid
 * context contamination across iterations.
 */
export function stripThinkBlocks(content: string): string {
    if (!content) return '';
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * Truncate a tool result for the response summary. Full result
 * still goes back to the LLM (so it can act on it) — this is just
 * for human/debug visibility.
 */
function summarize(result: string, max = RESULT_SUMMARY_MAX_CHARS): string {
    if (result.length <= max) return result;
    return result.slice(0, max) + ` ... [truncated, total ${result.length} chars]`;
}

/**
 * Validate the agent request. Returns an error result if invalid,
 * otherwise null. Defense in depth at the agent boundary.
 */
function validateRequest(req: AgentRequest): AgentResult<never> | null {
    if (!req || typeof req.prompt !== 'string' || req.prompt.trim() === '') {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: 'coderAgent: prompt is required and must be a non-empty string.'
            }
        };
    }
    if (req.max_tokens !== undefined && (req.max_tokens < 1 || req.max_tokens > 32768)) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: `coderAgent: max_tokens must be 1-32768, got ${req.max_tokens}.`
            }
        };
    }
    if (req.temperature !== undefined && (req.temperature < 0 || req.temperature > 2)) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: `coderAgent: temperature must be 0-2, got ${req.temperature}.`
            }
        };
    }
    if (req.max_iterations !== undefined &&
        (req.max_iterations < 1 || req.max_iterations > HARD_MAX_ITERATIONS)) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: `coderAgent: max_iterations must be 1-${HARD_MAX_ITERATIONS}, got ${req.max_iterations}.`
            }
        };
    }
    return null;
}

/**
 * Convert our AgentTool[] to the OpenAI tools[] format.
 * Only includes tools the LLM is allowed to call (filtered by req.tools).
 */
function buildOpenAITools(
    allTools: AgentTool[],
    allowedNames: Set<string> | undefined
): Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }> {
    const filtered = allowedNames
        ? allTools.filter(t => allowedNames.has(t.name))
        : allTools;
    return filtered.map(t => ({
        type: 'function' as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters
        }
    }));
}

/**
 * Options bag for coderAgent. Kept separate from the request so
 * we can add transport-level concerns (logging, persistence) without
 * polluting the agent-layer API.
 */
export interface CoderAgentOpts {
    /** Optional progress callback. Receives one event per state change. */
    onProgress?: (e: AgentProgressEvent) => void;
    /** Optional session writer. Persists events to JSONL. */
    sessionWriter?: SessionWriter;
    /** Session id (must match writer's id if both provided). */
    sessionId?: string;
    /** When true, log every event to stderr too. */
    verbose?: boolean;
}

/**
 * Run the agent loop.
 *
 * @param req         Agent request (prompt, system, knobs).
 * @param client      Pre-configured OpenAI client.
 * @param allTools    All available AgentTool definitions.
 * @param executor    Callback to execute a tool by name (provided by the
 *                    tool wrapper layer; bridges to MCP ToolDef.handler).
 * @param cfg         LLM config (defaults for model/baseUrl).
 * @param opts        Transport-level options (logging, persistence).
 */
export async function coderAgent(
    req: AgentRequest,
    client: OpenAI,
    allTools: AgentTool[],
    executor: ToolExecutor,
    cfg: LlmConfig,
    opts: CoderAgentOpts = {}
): Promise<AgentResult<AgentResponse>> {
    // ── Validate ───────────────────────────────────────────
    const validationError = validateRequest(req);
    if (validationError) return validationError;

    const sessionId = opts.sessionId || opts.sessionWriter?.getSessionId() || 'agent-' + Date.now();
    const system = req.system || DEFAULT_SYSTEM_PROMPT;
    const model = req.model || cfg.defaultModel || 'MiniMax-M3';
    const max_tokens = req.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = req.temperature ?? DEFAULT_TEMPERATURE;
    const max_iterations = Math.min(req.max_iterations ?? DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS);
    const tool_choice = req.tool_choice ?? 'auto';

    // Helper: emit an event through both channels (callback + JSONL).
    const emit = (event: SessionEvent): void => {
        if (opts.onProgress) {
            try {
                opts.onProgress({ session_id: sessionId, event });
            } catch {
                // Don't let a bad listener kill the loop.
            }
        }
        if (opts.sessionWriter) {
            opts.sessionWriter.write(event);
        }
        if (opts.verbose) {
            const summary = summarizeEvent(event);
            if (summary) process.stderr.write(`[mavis-mcp] [${sessionId}] ${summary}\n`);
        }
    };

    // Helper: produce a short human-readable summary of an event for verbose mode.
    function summarizeEvent(e: SessionEvent): string | null {
        switch (e.event) {
            case 'start': return `start: model=${e.model} max_iterations=${e.max_iterations} prompt="${e.prompt.slice(0, 60).replace(/\n/g, ' ')}..."`;
            case 'iteration_start': return `iter ${e.iteration}: calling LLM...`;
            case 'llm_call': return `iter ${e.iteration}: LLM responded in ${e.latency_ms}ms (${e.usage.total_tokens} tokens, finish=${e.finish_reason})`;
            case 'tool_call': return `iter ${e.iteration}: ${e.tool_name}(${JSON.stringify(e.tool_args).slice(0, 80)})`;
            case 'tool_result': return `iter ${e.iteration}: ${e.tool_name} → ${e.is_error ? 'ERROR' : 'OK'} in ${e.duration_ms}ms`;
            case 'iteration_end': return `iter ${e.iteration}: ${e.had_tool_calls ? 'had tool calls' : 'no tool calls'}`;
            case 'end': return `END: ${e.finish_reason} after ${e.iterations} iters in ${e.total_ms}ms (${e.total_usage.total_tokens} total tokens)`;
            case 'error': return `ERROR: ${e.message}`;
        }
    }

    // ── Emit start ─────────────────────────────────────────
    emit({
        ts: new Date().toISOString(),
        session_id: sessionId,
        event: 'start',
        prompt: req.prompt,
        system,
        model,
        max_iterations
    });

    // ── Build tools ────────────────────────────────────────
    const allowedNames = req.tools
        ? new Set(req.tools)
        : new Set(allTools.map(t => t.name).filter(n =>
            n !== 'mavis_coder' && n !== 'mavis_coder_agent'));

    const tools = buildOpenAITools(allTools, allowedNames);
    if (tools.length === 0) {
        const err: AgentResult<never> = {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: 'coderAgent: no tools available after filtering. Check req.tools or tool registry.'
            }
        };
        emit({
            ts: new Date().toISOString(),
            session_id: sessionId,
            event: 'error',
            message: err.error.message
        });
        return err;
    }

    // ── Build initial messages ─────────────────────────────
    const messages: ChatCompletionMessageParam[] = [];
    messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: req.prompt });

    // ── Loop ───────────────────────────────────────────────
    const toolCalls: AgentToolCallRecord[] = [];
    const totalUsage: CoderUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let iterations = 0;
    let finalContent = '';
    let finishReason: AgentResponse['finish_reason'] = 'error';
    let lastModel = model;

    const tStart = process.hrtime.bigint();

    try {
        while (iterations < max_iterations) {
            iterations++;

            emit({
                ts: new Date().toISOString(),
                session_id: sessionId,
                event: 'iteration_start',
                iteration: iterations
            });

            // Call LLM. We use non-streaming for v1 — simpler error
            // handling and easier to aggregate usage. B-3 can add
            // streaming if latency becomes an issue.
            const tLlmStart = process.hrtime.bigint();
            const completion = await client.chat.completions.create({
                model,
                max_tokens,
                temperature,
                messages,
                tools,
                tool_choice
            });
            const tLlmEnd = process.hrtime.bigint();
            const llm_latency_ms = Number(tLlmEnd - tLlmStart) / 1_000_000;

            const usage = completion.usage ?? {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            };
            totalUsage.prompt_tokens += usage.prompt_tokens;
            totalUsage.completion_tokens += usage.completion_tokens;
            totalUsage.total_tokens += usage.total_tokens;
            lastModel = completion.model || model;

            const choice = completion.choices?.[0];
            if (!choice) {
                finishReason = 'error';
                break;
            }
            const message = choice.message;
            const finish_reason = choice.finish_reason;
            const assistantContent = message.content || '';
            const rawToolCalls: ChatCompletionMessageToolCall[] | undefined = message.tool_calls;

            emit({
                ts: new Date().toISOString(),
                session_id: sessionId,
                event: 'llm_call',
                iteration: iterations,
                latency_ms: Math.round(llm_latency_ms * 100) / 100,
                usage: {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens
                },
                finish_reason: finish_reason || 'unknown'
            });

            const cleanContent = stripThinkBlocks(assistantContent);

            // No tool calls → we're done. Return the cleaned content.
            if (!rawToolCalls || rawToolCalls.length === 0) {
                finalContent = cleanContent;
                if (finish_reason === 'stop') finishReason = 'stop';
                else if (finish_reason === 'length') finishReason = 'length';
                else if (finish_reason === 'content_filter') finishReason = 'content_filter';
                else finishReason = 'stop';
                emit({
                    ts: new Date().toISOString(),
                    session_id: sessionId,
                    event: 'iteration_end',
                    iteration: iterations,
                    had_tool_calls: false
                });
                break;
            }

            // Append the assistant message (with tool_calls) to history.
            messages.push({
                role: 'assistant',
                content: cleanContent || null,
                tool_calls: rawToolCalls
            } as ChatCompletionMessageParam);

            // Execute each tool call and append the result message.
            for (const tc of rawToolCalls) {
                if (tc.type !== 'function') continue;
                const toolName = tc.function.name;
                let parsedArgs: Record<string, any> = {};
                let parseError: string | null = null;
                try {
                    parsedArgs = JSON.parse(tc.function.arguments || '{}');
                } catch (err: any) {
                    parseError = err?.message || String(err);
                }

                emit({
                    ts: new Date().toISOString(),
                    session_id: sessionId,
                    event: 'tool_call',
                    iteration: iterations,
                    tool_name: toolName,
                    tool_args: parsedArgs,
                    tool_call_id: tc.id
                });

                // Validate the tool is in the allowed set.
                if (!allowedNames.has(toolName)) {
                    const errMsg = `Error: tool "${toolName}" not in allowed set. Available: ${Array.from(allowedNames).join(', ')}`;
                    toolCalls.push({
                        iteration: iterations,
                        tool_name: toolName,
                        tool_args: parsedArgs,
                        result_summary: errMsg,
                        is_error: true,
                        duration_ms: 0
                    });
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: errMsg
                    } as ChatCompletionMessageParam);
                    emit({
                        ts: new Date().toISOString(),
                        session_id: sessionId,
                        event: 'tool_result',
                        iteration: iterations,
                        tool_call_id: tc.id,
                        tool_name: toolName,
                        result_summary: errMsg,
                        is_error: true,
                        duration_ms: 0
                    });
                    continue;
                }

                if (parseError) {
                    const errMsg = `Error: tool arguments must be valid JSON. ${parseError}`;
                    toolCalls.push({
                        iteration: iterations,
                        tool_name: toolName,
                        tool_args: {},
                        result_summary: errMsg,
                        is_error: true,
                        duration_ms: 0
                    });
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: errMsg
                    } as ChatCompletionMessageParam);
                    emit({
                        ts: new Date().toISOString(),
                        session_id: sessionId,
                        event: 'tool_result',
                        iteration: iterations,
                        tool_call_id: tc.id,
                        tool_name: toolName,
                        result_summary: errMsg,
                        is_error: true,
                        duration_ms: 0
                    });
                    continue;
                }

                // Execute the tool.
                const tToolStart = process.hrtime.bigint();
                let result: { content: string; is_error: boolean };
                try {
                    result = await executor(toolName, parsedArgs);
                } catch (err: any) {
                    result = {
                        content: `Error: tool execution threw: ${err?.message || String(err)}`,
                        is_error: true
                    };
                }
                const tToolEnd = process.hrtime.bigint();
                const duration_ms = Number(tToolEnd - tToolStart) / 1_000_000;

                const resultSummary = summarize(result.content);
                toolCalls.push({
                    iteration: iterations,
                    tool_name: toolName,
                    tool_args: parsedArgs,
                    result_summary: resultSummary,
                    is_error: result.is_error,
                    duration_ms: Math.round(duration_ms * 100) / 100
                });

                const toolMessageContent = result.is_error
                    ? `Error: ${result.content}`
                    : result.content;

                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: toolMessageContent
                } as ChatCompletionMessageParam);

                emit({
                    ts: new Date().toISOString(),
                    session_id: sessionId,
                    event: 'tool_result',
                    iteration: iterations,
                    tool_call_id: tc.id,
                    tool_name: toolName,
                    result_summary: resultSummary,
                    is_error: result.is_error,
                    duration_ms: Math.round(duration_ms * 100) / 100
                });
            }

            emit({
                ts: new Date().toISOString(),
                session_id: sessionId,
                event: 'iteration_end',
                iteration: iterations,
                had_tool_calls: true
            });
        }

        if (iterations >= max_iterations && finishReason === 'error' && finalContent === '') {
            finishReason = 'max_iterations';
        }
        if (iterations === max_iterations && finalContent === '' && toolCalls.length > 0) {
            finishReason = 'max_iterations';
        }
    } catch (err: any) {
        const tEnd = process.hrtime.bigint();
        const latency_ms = Number(tEnd - tStart) / 1_000_000;

        const status = err?.status ?? err?.response?.status;
        const message = err?.message || String(err);
        let kind = 'api_error';
        if (status === 401) kind = 'auth_error';
        else if (status === 429) kind = 'rate_limit';
        else if (status && status >= 400 && status < 500) kind = 'client_error';
        else if (status && status >= 500) kind = 'server_error';

        emit({
            ts: new Date().toISOString(),
            session_id: sessionId,
            event: 'error',
            message: `${kind}: ${message}`
        });

        return {
            ok: false,
            error: {
                kind,
                message: `coderAgent: ${message}`,
                details: {
                    status,
                    iterations_completed: iterations,
                    tool_calls_made: toolCalls.length,
                    latency_ms: Math.round(latency_ms * 100) / 100
                }
            }
        };
    }

    const tEnd = process.hrtime.bigint();
    const latency_ms = Number(tEnd - tStart) / 1_000_000;

    emit({
        ts: new Date().toISOString(),
        session_id: sessionId,
        event: 'end',
        finish_reason: finishReason,
        iterations,
        total_ms: Math.round(latency_ms * 100) / 100,
        final_content_preview: finalContent.slice(0, 200),
        total_usage: totalUsage
    });

    if (opts.sessionWriter) opts.sessionWriter.close();

    return {
        ok: true,
        data: {
            final_content: finalContent,
            iterations,
            tool_calls: toolCalls,
            total_usage: totalUsage,
            latency_ms: Math.round(latency_ms * 100) / 100,
            finish_reason: finishReason,
            model: lastModel
        }
    };
}
