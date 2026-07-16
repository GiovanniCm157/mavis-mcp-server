/**
 * Mavis Coder agent — single-shot text generation via MiniMax-M3.
 *
 * Sprint B-1: text-in / text-out. No tool calling yet. This validates
 * the pipeline (auth, request shape, response parsing) before we add
 * the full agent loop in Sprint B-2.
 *
 * Uses the OpenAI SDK because MiniMax-M3 is OpenAI-compatible. The
 * server instantiates the client once at startup (see src/cli.ts) and
 * passes it in, so we don't leak API keys into per-call construction.
 *
 * Design notes:
 *   - Pure function: takes (request, client, config), returns Promise<CoderResponse>.
 *   - No I/O outside the API call. No filesystem, no console.
 *   - Errors are caught and returned as AgentResult so the tool layer
 *     can serialize them as MCP error responses without throwing.
 *   - Latency is measured with process.hrtime.bigint() for monotonicity.
 */

import OpenAI from 'openai';
import type {
    AgentResult,
    CoderRequest,
    CoderResponse,
    LlmConfig
} from './types.js';

const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

/**
 * Single-shot call to MiniMax-M3 (or any OpenAI-compatible model).
 *
 * @param req   Prompt and optional knobs.
 * @param client Pre-configured OpenAI client (built in cli.ts with the API key).
 * @param cfg   Server config (for default model id).
 */
export async function coderCall(
    req: CoderRequest,
    client: OpenAI,
    cfg: LlmConfig
): Promise<AgentResult<CoderResponse>> {
    // Validate request — defense in depth at the agent boundary even
    // though the tool layer also validates. Cheap and surfaces clear
    // error messages to callers.
    if (!req || typeof req.prompt !== 'string' || req.prompt.trim() === '') {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: 'coderCall: prompt is required and must be a non-empty string.'
            }
        };
    }
    if (req.max_tokens !== undefined && (req.max_tokens < 1 || req.max_tokens > 32768)) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: `coderCall: max_tokens must be 1-32768, got ${req.max_tokens}.`
            }
        };
    }
    if (req.temperature !== undefined && (req.temperature < 0 || req.temperature > 2)) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: `coderCall: temperature must be 0-2, got ${req.temperature}.`
            }
        };
    }

    const model = req.model || cfg.defaultModel || DEFAULT_MODEL;
    const max_tokens = req.max_tokens ?? DEFAULT_MAX_TOKENS;
    const temperature = req.temperature ?? DEFAULT_TEMPERATURE;

    // Build messages array. System prompt is optional but strongly
    // recommended for coding tasks — keeps the model on-rails.
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) {
        messages.push({ role: 'system', content: req.system });
    }
    messages.push({ role: 'user', content: req.prompt });

    const t0 = process.hrtime.bigint();
    try {
        const completion = await client.chat.completions.create({
            model,
            max_tokens,
            temperature,
            messages
        });

        const t1 = process.hrtime.bigint();
        const latency_ms = Number(t1 - t0) / 1_000_000;

        // Extract response. The OpenAI SDK returns a structured object;
        // we read the first choice and pull out content/usage.
        const choice = completion.choices?.[0];
        const content = choice?.message?.content ?? '';
        const finish_reason = choice?.finish_reason ?? 'unknown';
        const usage = completion.usage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        };

        return {
            ok: true,
            data: {
                content,
                usage: {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens
                },
                model: completion.model || model,
                latency_ms: Math.round(latency_ms * 100) / 100,
                finish_reason
            }
        };
    } catch (err: any) {
        const t1 = process.hrtime.bigint();
        const latency_ms = Number(t1 - t0) / 1_000_000;

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
                message: `coderCall: ${message}`,
                details: { status, latency_ms: Math.round(latency_ms * 100) / 100 }
            }
        };
    }
}
