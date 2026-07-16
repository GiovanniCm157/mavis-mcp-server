/**
 * Mavis Coder Agent — full agent loop with tool calling.
 *
 * Sprint B-2. The LLM can call any of the registered tools (mavis_bash,
 * mavis_read, mavis_write, mavis_edit, mavis_search, mavis_git,
 * mavis_supabase, mavis_run_tests, mavis_state) iteratively until it
 * produces a final response or hits max_iterations.
 *
 * Design notes:
 *   - Pure function: takes (request, client, tools, executor, cfg) and
 *     returns Promise<AgentResult<AgentResponse>>. No I/O outside the
 *     LLM API and the tool executor.
 *   - Think block stripping: after each LLM response, strip <think>...</think>
 *     blocks from the assistant content before adding to the message
 *     history. Prevents the model from "listening to itself" across iterations.
 *   - Tool recursion guard: by default, mavis_coder and mavis_coder_agent
 *     are NOT exposed to the LLM. Caller can opt in via req.tools.
 *   - Errors during a tool call don't crash the loop — they're recorded
 *     as is_error=true and sent back to the LLM as a tool message with
 *     an "Error: " prefix. The model can retry or take a different path.
 *   - Latency: hrtime.bigint() (monotonic) for both per-tool and total.
 *   - Token aggregation: we sum usage across all iterations. v1 doesn't
 *     truncate the context — long loops accumulate input tokens. B-3 can
 *     add compaction if it becomes a problem.
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

const DEFAULT_MAX_ITERATIONS = 10;
const HARD_MAX_ITERATIONS = 30;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
const RESULT_SUMMARY_MAX_CHARS = 500;

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
 * Run the agent loop.
 *
 * @param req         Agent request (prompt, system, knobs).
 * @param client      Pre-configured OpenAI client.
 * @param allTools    All available AgentTool definitions.
 * @param executor    Callback to execute a tool by name (provided by the
 *                    tool wrapper layer; bridges to MCP ToolDef.handler).
 * @param cfg         LLM config (defaults for model/baseUrl).
 */
export async function coderAgent(
    req: AgentRequest,
    client: OpenAI,
    allTools: AgentTool[],
    executor: ToolExecutor,
    cfg: LlmConfig
): Promise<AgentResult<AgentResponse>> {
    // ── Validate ───────────────────────────────────────────
    const validationError = validateRequest(req);
    if (validationError) return validationError;

    const model = req.model || cfg.defaultModel || 'MiniMax-M3';
    const max_tokens = req.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = req.temperature ?? DEFAULT_TEMPERATURE;
    const max_iterations = Math.min(req.max_iterations ?? DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS);
    const tool_choice = req.tool_choice ?? 'auto';

    // ── Build tools ────────────────────────────────────────
    // Default exclusion: don't let the LLM recurse into coder tools
    // (would risk infinite loops and double-charges tokens).
    const allowedNames = req.tools
        ? new Set(req.tools)
        : new Set(allTools.map(t => t.name).filter(n =>
            n !== 'mavis_coder' && n !== 'mavis_coder_agent'));

    const tools = buildOpenAITools(allTools, allowedNames);
    if (tools.length === 0) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: 'coderAgent: no tools available after filtering. Check req.tools or tool registry.'
            }
        };
    }

    // ── Build initial messages ─────────────────────────────
    const messages: ChatCompletionMessageParam[] = [];
    if (req.system) {
        messages.push({ role: 'system', content: req.system });
    }
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

            // Call LLM. We use non-streaming for v1 — simpler error
            // handling and easier to aggregate usage. B-3 can add
            // streaming if latency becomes an issue.
            const completion = await client.chat.completions.create({
                model,
                max_tokens,
                temperature,
                messages,
                tools,
                tool_choice
            });

            // Aggregate usage. OpenAI's usage object may be undefined
            // on some providers — we default to zeros to keep math sane.
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

            // Strip think blocks from the content for history. We
            // keep them in `finalContent` only on the final iteration
            // (the very last assistant message, with no tool_calls).
            const cleanContent = stripThinkBlocks(assistantContent);

            // No tool calls → we're done. Return the cleaned content.
            if (!rawToolCalls || rawToolCalls.length === 0) {
                finalContent = cleanContent;
                if (finish_reason === 'stop') finishReason = 'stop';
                else if (finish_reason === 'length') finishReason = 'length';
                else if (finish_reason === 'content_filter') finishReason = 'content_filter';
                else finishReason = 'stop'; // best-effort default
                break;
            }

            // Append the assistant message (with tool_calls) to history.
            // We keep the raw content (with think blocks) for fidelity
            // — the model needs to see its own thinking for the next
            // iteration. Wait, no — we strip to avoid contamination.
            // Decision: strip for cleanliness, log raw separately if
            // needed for debug. v1 strips.
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

                // Validate the tool is in the allowed set. Even though
                // we filtered at the OpenAI level, the LLM might still
                // ask for excluded tools in edge cases (especially
                // when req.tools is set loosely).
                if (!allowedNames.has(toolName)) {
                    toolCalls.push({
                        iteration: iterations,
                        tool_name: toolName,
                        tool_args: parsedArgs,
                        result_summary: `Error: tool "${toolName}" not in allowed set`,
                        is_error: true,
                        duration_ms: 0
                    });
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: `Error: tool "${toolName}" not in allowed set. Available: ${Array.from(allowedNames).join(', ')}`
                    } as ChatCompletionMessageParam);
                    continue;
                }

                if (parseError) {
                    toolCalls.push({
                        iteration: iterations,
                        tool_name: toolName,
                        tool_args: {},
                        result_summary: `Error: invalid JSON arguments: ${parseError}`,
                        is_error: true,
                        duration_ms: 0
                    });
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: `Error: tool arguments must be valid JSON. ${parseError}`
                    } as ChatCompletionMessageParam);
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

                toolCalls.push({
                    iteration: iterations,
                    tool_name: toolName,
                    tool_args: parsedArgs,
                    result_summary: summarize(result.content),
                    is_error: result.is_error,
                    duration_ms: Math.round(duration_ms * 100) / 100
                });

                // Prefix error results so the LLM sees them clearly.
                const toolMessageContent = result.is_error
                    ? `Error: ${result.content}`
                    : result.content;

                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: toolMessageContent
                } as ChatCompletionMessageParam);
            }

            // Loop continues — next iteration will see the tool results.
        }

        // If we exited the loop because iterations ran out (not because
        // the LLM produced a final response), record it.
        if (iterations >= max_iterations && finishReason === 'error') {
            // The loop broke naturally above; this catches the case
            // where we hit the cap without an explicit stop.
            if (finalContent === '') {
                finishReason = 'max_iterations';
            }
        }
        // Also catch the case where the loop terminated by reaching
        // the cap and we never got a clean stop.
        if (iterations === max_iterations && finalContent === '' && toolCalls.length > 0) {
            finishReason = 'max_iterations';
        }
    } catch (err: any) {
        const tEnd = process.hrtime.bigint();
        const latency_ms = Number(tEnd - tStart) / 1_000_000;

        // Map common OpenAI error shapes to stable error kinds.
        const status = err?.status ?? err?.response?.status;
        const message = err?.message || String(err);
        let kind = 'api_error';
        if (status === 401) kind = 'auth_error';
        else if (status === 429) kind = 'rate_limit';
        else if (status && status >= 400 && status < 500) kind = 'client_error';
        else if (status && status >= 500) kind = 'server_error';

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
