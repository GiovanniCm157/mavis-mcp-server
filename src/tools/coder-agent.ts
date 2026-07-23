/**
 * mavis_coder_agent tool — wraps the coderAgent multi-step loop.
 *
 * Sprint B-2 + B-5. The LLM can call any of the registered workspace tools
 * (mavis_bash, mavis_read, mavis_write, mavis_edit, mavis_search,
 * mavis_git, mavis_supabase, mavis_run_tests, mavis_state) iteratively
 * until it produces a final response or hits max_iterations.
 *
 * B-5 additions:
 *   - Realtime progress: emits MCP logging notifications on each
 *     iteration + tool call (visible in Claude UI's tool panel).
 *   - Session log: persists the run to JSONL at
 *     ~/.mavis-mcp/agent-sessions/ (post-mortem + tail -f).
 *   - Default max_iterations: 20 (was 10). Hard cap 30.
 *   - Default system prompt for efficiency.
 *
 * Difference from mavis_coder (single-shot):
 *   - mavis_coder      : one prompt → one response, no tools
 *   - mavis_coder_agent: prompt + tools → multi-step loop → final response
 *
 * Use mavis_coder_agent for tasks that require reading, searching, or
 * modifying the workspace. Use mavis_coder for one-off text generation.
 *
 * Default tool exposure: all mavis_* tools EXCEPT mavis_coder and
 * mavis_coder_agent (avoids recursion). To re-enable them, pass them
 * explicitly in `tools`.
 *
 * Input:
 *   prompt           (string, required)
 *   system           (string, optional — defaults to efficiency-focused prompt)
 *   model            (string, optional — defaults to MiniMax-M3)
 *   max_tokens       (int, optional — per-iteration, defaults to 4096)
 *   temperature      (number 0-2, optional — defaults to 0.2)
 *   max_iterations   (int 1-30, optional — defaults to 20)
 *   tools            (string[], optional — restrict to subset)
 *   tool_choice      (string | object, optional — default "auto")
 *   session_id       (string, optional — auto-generated if omitted)
 *   persist_session  (bool, optional — default true, set false to skip JSONL)
 *
 * Output (success):
 *   { ok: true, data: { final_content, iterations, tool_calls[],
 *                       total_usage, latency_ms, finish_reason, model,
 *                       session_id, session_log_path } }
 *
 * Output (error):
 *   { ok: false, error: { kind, message, details? } }
 */

import { randomUUID } from 'node:crypto';
import { coderAgent, type AgentProgressEvent } from '../agents/coder-loop.js';
import { SessionWriter } from '../agents/session-log.js';
import type { AgentRequest, AgentTool, ToolExecutor } from '../agents/types.js';
import type { ToolDef } from './types.js';

/**
 * Extract text content from a tool call result. Tools may return
 * multiple content blocks (text + image) — for the LLM we only forward
 * the text parts, joined with newlines. Image parts are dropped (v1).
 */
function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text)
        .join('\n');
}

export const coderAgentTool: ToolDef = {
    name: 'mavis_coder_agent',
    description:
        'Run a multi-step agent loop where MiniMax-M3 can call ANY mavis_* tool ' +
        '(mavis_bash, mavis_read, mavis_write, mavis_edit, mavis_search, mavis_git, ' +
        'mavis_supabase, mavis_run_tests, mavis_state, mavis_auditor, mavis_noter, ' +
        'mavis_session_log, mavis_coder) iteratively until the task is done. ' +
        'Default doctrine (B-6): ALL tools are exposed to the LLM — ' +
        'including non-LLM ones. The LLM is the one that decides which to call. ' +
        'Only mavis_coder_agent is excluded (recursion guard). ' +
        'Emits realtime progress notifications (visible in client UI) and persists ' +
        'the full run to ~/.mavis-mcp/agent-sessions/.',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The task to accomplish. Be specific about what you want done.'
            },
            system: {
                type: 'string',
                description: 'Optional system prompt. If omitted, uses a default efficiency-focused prompt.'
            },
            model: {
                type: 'string',
                description: 'Model id. Defaults to MiniMax-M3.'
            },
            max_tokens: {
                type: 'integer',
                minimum: 1,
                maximum: 32768,
                description: 'Max output tokens per iteration. Defaults to 4096.'
            },
            temperature: {
                type: 'number',
                minimum: 0,
                maximum: 2,
                description: 'Sampling temperature. Defaults to 0.2 (deterministic).'
            },
            max_iterations: {
                type: 'integer',
                minimum: 1,
                maximum: 30,
                description: 'Max agent iterations. Defaults to 20. Hard cap 30.'
            },
            tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Subset of tool names to expose. If omitted, all mavis_* tools are available except coder tools.'
            },
            tool_choice: {
                description: 'Tool choice strategy. "auto" (default), "required", "none", or { type: "function", function: { name: "X" } }.'
            },
            session_id: {
                type: 'string',
                description: 'Optional session id. Auto-generated (UUID) if omitted. Use the same id to chain or reference via mavis_session_log.'
            },
            persist_session: {
                type: 'boolean',
                description: 'If true (default), write the run to JSONL in ~/.mavis-mcp/agent-sessions/. Set false to skip persistence.'
            }
        },
        required: ['prompt'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        // Resolve LLM client + config.
        const llm = (ctx as any).llm;
        if (!llm || !llm.client) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ok: false,
                        error: {
                            kind: 'config_error',
                            message: 'mavis_coder_agent: LLM client not configured. Set MINIMAX_API_KEY in .env and restart the server.'
                        }
                    }, null, 2)
                }],
                isError: true
            };
        }

        // Resolve tool registry from context. The server injects this
        // at startup so we avoid circular imports. Exclude only self
        // (mavis_coder_agent) for recursion guard. ALL other mavis_*
        // tools are exposed to the LLM — including non-LLM ones
        // (mavis_auditor, mavis_noter, mavis_session_log) per B-6 doctrine:
        // "MiniMax does everything except think."
        const registry = ctx.toolRegistry || [];
        const allowedTools = registry.filter(
            t => t.name !== 'mavis_coder_agent'
        );

        // Build AgentTool[] from the MCP registry.
        const agentTools: AgentTool[] = allowedTools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            execute: async (toolArgs) => {
                try {
                    const result = await t.handler(toolArgs, ctx);
                    return {
                        content: extractText(result),
                        is_error: !!result.isError
                    };
                } catch (err: any) {
                    return {
                        content: `Error: tool execution threw: ${err?.message || String(err)}`,
                        is_error: true
                    };
                }
            }
        }));

        const executor: ToolExecutor = async (name, toolArgs) => {
            const t = allowedTools.find(x => x.name === name);
            if (!t) {
                return {
                    content: `Error: tool "${name}" not in registry.`,
                    is_error: true
                };
            }
            try {
                const result = await t.handler(toolArgs, ctx);
                return {
                    content: extractText(result),
                    is_error: !!result.isError
                };
            } catch (err: any) {
                return {
                    content: `Error: tool execution threw: ${err?.message || String(err)}`,
                    is_error: true
                };
            }
        };

        // Build AgentRequest.
        let toolChoice: AgentRequest['tool_choice'];
        if (args.tool_choice !== undefined) {
            if (typeof args.tool_choice === 'string') {
                if (args.tool_choice === 'auto' || args.tool_choice === 'required' || args.tool_choice === 'none') {
                    toolChoice = args.tool_choice;
                }
            } else {
                toolChoice = args.tool_choice as any;
            }
        }

        const req: AgentRequest = {
            prompt: String(args.prompt ?? ''),
            system: args.system !== undefined ? String(args.system) : undefined,
            model: args.model !== undefined ? String(args.model) : undefined,
            max_tokens: args.max_tokens !== undefined ? Number(args.max_tokens) : undefined,
            temperature: args.temperature !== undefined ? Number(args.temperature) : undefined,
            max_iterations: args.max_iterations !== undefined ? Number(args.max_iterations) : undefined,
            tools: Array.isArray(args.tools) ? args.tools.map(String) : undefined,
            tool_choice: toolChoice
        };

        // ── Session setup (B-5) ────────────────────────────
        const sessionId = args.session_id !== undefined
            ? String(args.session_id)
            : `agent-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const persist = args.persist_session !== false; // default true

        const sessionWriter = persist
            ? new SessionWriter({ sessionId, promptPrefix: req.prompt.slice(0, 100) })
            : undefined;

        // ── onProgress callback (B-5) ──────────────────────
        // Forwards events to:
        //   1. MCP logging notification (if ctx.notify is set — wired by server.ts)
        //   2. SessionWriter (for JSONL persistence — handled inside coderAgent via opts)
        //   3. Stderr if MAVIS_MCP_VERBOSE=1
        const onProgress = (e: AgentProgressEvent): void => {
            if (ctx.notify) {
                const level = e.event.event === 'error' ? 'error'
                    : e.event.event === 'tool_result' && (e.event as any).is_error ? 'warning'
                    : 'info';
                ctx.notify(level, `[${e.event.event}] iter=${(e.event as any).iteration ?? '-'}`, {
                    session_id: e.session_id,
                    event: e.event
                });
            }
        };

        const result = await coderAgent(
            req,
            llm.client,
            agentTools,
            executor,
            llm.config,
            {
                onProgress,
                sessionWriter,
                sessionId,
                verbose: process.env.MAVIS_MCP_VERBOSE === '1'
            }
        );

        // Augment the success data with session metadata so the caller
        // can reference the session later via mavis_session_log.
        if (result.ok && sessionWriter) {
            (result.data as any).session_id = sessionId;
            (result.data as any).session_log_path = sessionWriter.getFilePath();
        } else if (result.ok) {
            (result.data as any).session_id = sessionId;
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }],
            isError: !result.ok
        };
    }
};
