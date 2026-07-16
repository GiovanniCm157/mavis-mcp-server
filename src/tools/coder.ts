/**
 * mavis_coder tool — wraps the coderCall agent for MCP clients.
 *
 * Single-shot text generation via MiniMax-M3. Sprint B-1 — no tool
 * calling yet (that's B-2).
 *
 * Input:
 *   prompt       (string, required)
 *   system       (string, optional)
 *   model        (string, optional — defaults to MiniMax-M3)
 *   max_tokens   (int, optional — defaults to 4096)
 *   temperature  (number 0-2, optional — defaults to 0.2)
 *
 * Output (success):
 *   { ok: true, data: { content, usage, model, latency_ms, finish_reason } }
 *
 * Output (error):
 *   { ok: false, error: { kind, message, details? } }
 *
 * The OpenAI client is created once in cli.ts and stored on the
 * ToolContext as `llm` (see tools/types.ts). If `llm` is missing
 * we return a clear config error — this happens when the server
 * is started without MINIMAX_API_KEY.
 */

import OpenAI from 'openai';
import { coderCall } from '../agents/coder.js';
import type { CoderRequest, LlmConfig } from '../agents/types.js';
import type { ToolDef } from './types.js';

export const coderTool: ToolDef = {
    name: 'mavis_coder',
    description:
        'Call MiniMax-M3 (OpenAI-compatible) for a single text generation. ' +
        'Use for drafting code, writing explanations, summarizing files, or any text-in/text-out task. ' +
        'Returns the model content plus token usage and latency. ' +
        'For multi-step agentic work with tool calling, see Sprint B-2 (not yet implemented).',
    inputSchema: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'The task or question to send to the model.'
            },
            system: {
                type: 'string',
                description: 'Optional system prompt that sets behavior/context.'
            },
            model: {
                type: 'string',
                description: 'Model id. Defaults to MiniMax-M3.'
            },
            max_tokens: {
                type: 'integer',
                minimum: 1,
                maximum: 32768,
                description: 'Max output tokens. Defaults to 4096.'
            },
            temperature: {
                type: 'number',
                minimum: 0,
                maximum: 2,
                description: 'Sampling temperature. Defaults to 0.2 (deterministic).'
            }
        },
        required: ['prompt'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        // Resolve LLM client + config from context. The cli.ts wires
        // these at startup; if either is missing we return a config error
        // rather than throwing.
        const llm = (ctx as any).llm as { client: OpenAI; config: LlmConfig } | undefined;
        if (!llm || !llm.client) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ok: false,
                        error: {
                            kind: 'config_error',
                            message: 'mavis_coder: LLM client not configured. Set MINIMAX_API_KEY in .env and restart the server.'
                        }
                    }, null, 2)
                }],
                isError: true
            };
        }

        const req: CoderRequest = {
            prompt: String(args.prompt ?? ''),
            system: args.system !== undefined ? String(args.system) : undefined,
            model: args.model !== undefined ? String(args.model) : undefined,
            max_tokens: args.max_tokens !== undefined ? Number(args.max_tokens) : undefined,
            temperature: args.temperature !== undefined ? Number(args.temperature) : undefined
        };

        const result = await coderCall(req, llm.client, llm.config);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }],
            isError: !result.ok
        };
    }
};
