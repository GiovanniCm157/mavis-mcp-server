/**
 * mavis_coder_agent tool — wraps the coderAgent multi-step loop.
 *
 * Sprint B-2. The LLM can call any of the registered workspace tools
 * (mavis_bash, mavis_read, mavis_write, mavis_edit, mavis_search,
 * mavis_git, mavis_supabase, mavis_run_tests, mavis_state) iteratively
 * until it produces a final response or hits max_iterations.
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
 *   system           (string, optional)
 *   model            (string, optional — defaults to MiniMax-M3)
 *   max_tokens       (int, optional — per-iteration, defaults to 4096)
 *   temperature      (number 0-2, optional — defaults to 0.2)
 *   max_iterations   (int 1-30, optional — defaults to 10)
 *   tools            (string[], optional — restrict to subset)
 *   tool_choice      (string | object, optional — default "auto")
 *
 * Output (success):
 *   { ok: true, data: { final_content, iterations, tool_calls[],
 *                       total_usage, latency_ms, finish_reason, model } }
 *
 * Output (error):
 *   { ok: false, error: { kind, message, details? } }
 */

import { coderAgent } from '../agents/coder-loop.js';
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
        'Run a multi-step agent loop where MiniMax-M3 can call workspace tools ' +
        '(mavis_bash, mavis_read, mavis_write, mavis_edit, mavis_search, mavis_git, ' +
        'mavis_supabase, mavis_run_tests, mavis_state) iteratively until the task is done. ' +
        'Use this for tasks that require reading files, searching the codebase, running ' +
        'commands, or making multi-step changes. For one-off text generation, use ' +
        'mavis_coder instead. Default tool exposure excludes mavis_coder and ' +
        'mavis_coder_agent (no recursion).',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The task to accomplish. Be specific about what you want done.'
            },
            system: {
                type: 'string',
                description: 'Optional system prompt. Strongly recommended for coding tasks.'
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
                description: 'Max agent iterations. Defaults to 10. Hard cap 30.'
            },
            tools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Subset of tool names to expose. If omitted, all mavis_* tools are available except coder tools.'
            },
            tool_choice: {
                description: 'Tool choice strategy. "auto" (default), "required", "none", or { type: "function", function: { name: "X" } }.'
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
        // at startup so we avoid circular imports. Exclude self and
        // single-shot coder to prevent the LLM from recursing.
        const registry = ctx.toolRegistry || [];
        const allowedTools = registry.filter(
            t => t.name !== 'mavis_coder_agent' && t.name !== 'mavis_coder'
        );

        // Build AgentTool[] from the MCP registry. The execute function
        // bridges MCP ToolDef.handler to the AgentTool contract.
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

        // Build executor for the loop. Same as execute above but keyed
        // by name. The agent loop calls this.
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

        // Build AgentRequest. tool_choice arrives as either a string
        // or an object — we coerce with JSON parse/string compare.
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

        const result = await coderAgent(req, llm.client, agentTools, executor, llm.config);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }],
            isError: !result.ok
        };
    }
};
