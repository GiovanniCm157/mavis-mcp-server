/**
 * Tests for the mavis_coder tool and the underlying coderCall agent.
 *
 * Sprint B-1: single-shot text generation. We mock the OpenAI client
 * to avoid real API calls in tests. The mock is a minimal stand-in
 * that records the request and returns a configurable response.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspace } from '../src/workspace.js';
import { State } from '../src/state.js';
import { coderCall } from '../src/agents/coder.js';
import { coderTool } from '../src/tools/coder.js';
import type { LlmConfig } from '../src/agents/types.js';
import type { ToolContext } from '../src/tools/types.js';

// ────────────────────────────────────────────────────────────
// Mock OpenAI client
// ────────────────────────────────────────────────────────────

interface MockClientCall {
    args: any;
    resolve?: (value: any) => void;
    reject?: (err: any) => void;
}

interface MockOpenAIClient {
    chat: {
        completions: {
            create: (args: any) => Promise<any>;
        };
    };
    calls: MockClientCall[];
    /** Inject a response that the next create() call will return. */
    enqueueOk: (response: any) => void;
    /** Inject an error that the next create() call will throw. */
    enqueueError: (err: any) => void;
}

function makeMockClient(): MockOpenAIClient {
    const calls: MockClientCall[] = [];
    const queue: Array<{ kind: 'ok' | 'err'; payload: any }> = [];

    const client: MockOpenAIClient = {
        chat: {
            completions: {
                create: async (args: any) => {
                    const next = queue.shift();
                    calls.push({ args });
                    if (!next) {
                        throw new Error('mock: no response queued');
                    }
                    if (next.kind === 'err') {
                        throw next.payload;
                    }
                    return next.payload;
                }
            }
        },
        calls,
        enqueueOk: (response) => queue.push({ kind: 'ok', payload: response }),
        enqueueError: (err) => queue.push({ kind: 'err', payload: err })
    };
    return client;
}

function makeLlmConfig(): LlmConfig {
    return {
        apiKey: 'sk-test-xxx',
        baseUrl: 'https://api.test/v1',
        defaultModel: 'MiniMax-M3'
    };
}

function makeCtx(overrides: { llm?: any } = {}): ToolContext {
    const workDir = mkdtempSync(join(tmpdir(), 'mavis-coder-'));
    // 'in' lets us distinguish "not set" (use default) from "explicitly undefined"
    // (the missing-LLM case the tool wrapper has to handle gracefully).
    const llm = 'llm' in overrides
        ? overrides.llm
        : { client: makeMockClient(), config: makeLlmConfig() };
    return {
        workspace: createWorkspace(workDir),
        state: new State(workDir),
        llm
    };
}

// ────────────────────────────────────────────────────────────
// coderCall (agent) tests
// ────────────────────────────────────────────────────────────

describe('coderCall (agent, single-shot)', () => {
    it('returns ok with content, usage, and latency on a successful call', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            id: 'cmpl-1',
            model: 'MiniMax-M3',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: 'hello back' },
                finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
        });

        const result = await coderCall({ prompt: 'say hi' }, client as any, makeLlmConfig());

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.content).toBe('hello back');
            expect(result.data.usage).toEqual({
                prompt_tokens: 12,
                completion_tokens: 7,
                total_tokens: 19
            });
            expect(result.data.model).toBe('MiniMax-M3');
            expect(result.data.finish_reason).toBe('stop');
            expect(result.data.latency_ms).toBeGreaterThanOrEqual(0);
        }
    });

    it('sends system + user messages in the right order', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });

        await coderCall(
            { prompt: 'do thing', system: 'you are a coding assistant' },
            client as any,
            makeLlmConfig()
        );

        const sent = client.calls[0].args;
        expect(sent.messages).toEqual([
            { role: 'system', content: 'you are a coding assistant' },
            { role: 'user', content: 'do thing' }
        ]);
    });

    it('omits system message when system is not provided', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });

        await coderCall({ prompt: 'just do it' }, client as any, makeLlmConfig());

        const sent = client.calls[0].args;
        expect(sent.messages).toEqual([{ role: 'user', content: 'just do it' }]);
    });

    it('uses request model when provided, otherwise config default', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });

        await coderCall({ prompt: 'p' }, client as any, makeLlmConfig());
        expect(client.calls[0].args.model).toBe('MiniMax-M3');

        client.enqueueOk({
            model: 'm2',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
        await coderCall({ prompt: 'p', model: 'other-model' }, client as any, makeLlmConfig());
        expect(client.calls[1].args.model).toBe('other-model');
    });

    it('applies default max_tokens=4096 and temperature=0.2 when not provided', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });

        await coderCall({ prompt: 'p' }, client as any, makeLlmConfig());
        const sent = client.calls[0].args;
        expect(sent.max_tokens).toBe(4096);
        expect(sent.temperature).toBe(0.2);
    });

    it('uses request max_tokens and temperature when provided', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });

        await coderCall(
            { prompt: 'p', max_tokens: 100, temperature: 0.8 },
            client as any,
            makeLlmConfig()
        );
        expect(client.calls[0].args.max_tokens).toBe(100);
        expect(client.calls[0].args.temperature).toBe(0.8);
    });

    it('rejects empty prompt with invalid_request', async () => {
        const client = makeMockClient();
        const result = await coderCall({ prompt: '' }, client as any, makeLlmConfig());
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
        // Mock client should NOT have been called.
        expect(client.calls.length).toBe(0);
    });

    it('rejects whitespace-only prompt with invalid_request', async () => {
        const client = makeMockClient();
        const result = await coderCall({ prompt: '   \n\t  ' }, client as any, makeLlmConfig());
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('rejects max_tokens < 1', async () => {
        const client = makeMockClient();
        const result = await coderCall(
            { prompt: 'p', max_tokens: 0 },
            client as any,
            makeLlmConfig()
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('rejects max_tokens > 32768', async () => {
        const client = makeMockClient();
        const result = await coderCall(
            { prompt: 'p', max_tokens: 50000 },
            client as any,
            makeLlmConfig()
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('rejects temperature outside 0-2', async () => {
        const client = makeMockClient();
        const result = await coderCall(
            { prompt: 'p', temperature: 2.5 },
            client as any,
            makeLlmConfig()
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('maps 401 to auth_error', async () => {
        const client = makeMockClient();
        const err = new Error('Unauthorized') as any;
        err.status = 401;
        client.enqueueError(err);

        const result = await coderCall({ prompt: 'p' }, client as any, makeLlmConfig());
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('auth_error');
            expect(result.error.details?.status).toBe(401);
        }
    });

    it('maps 429 to rate_limit', async () => {
        const client = makeMockClient();
        const err = new Error('Rate limit') as any;
        err.status = 429;
        client.enqueueError(err);

        const result = await coderCall({ prompt: 'p' }, client as any, makeLlmConfig());
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('rate_limit');
        }
    });

    it('maps 4xx to client_error and 5xx to server_error', async () => {
        const client = makeMockClient();
        const err400 = new Error('Bad request') as any;
        err400.status = 400;
        client.enqueueError(err400);

        const result400 = await coderCall({ prompt: 'p' }, client as any, makeLlmConfig());
        expect(result400.ok).toBe(false);
        if (!result400.ok) expect(result400.error.kind).toBe('client_error');

        const err500 = new Error('Server error') as any;
        err500.status = 500;
        client.enqueueError(err500);

        const result500 = await coderCall({ prompt: 'p' }, client as any, makeLlmConfig());
        expect(result500.ok).toBe(false);
        if (!result500.ok) expect(result500.error.kind).toBe('server_error');
    });

    it('handles empty content gracefully (returns empty string, not crash)', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }
        });

        const result = await coderCall({ prompt: 'p' }, client as any, makeLlmConfig());
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.content).toBe('');
        }
    });
});

// ────────────────────────────────────────────────────────────
// coderTool (MCP tool wrapper) tests
// ────────────────────────────────────────────────────────────

describe('mavis_coder (MCP tool wrapper)', () => {
    it('is registered with name mavis_coder', () => {
        expect(coderTool.name).toBe('mavis_coder');
        expect(coderTool.description).toBeTruthy();
        expect(coderTool.inputSchema.required).toContain('prompt');
    });

    it('returns config_error when llm context is missing', async () => {
        const ctx = makeCtx({ llm: undefined });
        const result = await coderTool.handler({ prompt: 'hi' }, ctx);

        expect(result.isError).toBe(true);
        const text = result.content[0]?.text as string;
        const parsed = JSON.parse(text);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.kind).toBe('config_error');
        expect(parsed.error.message).toContain('MINIMAX_API_KEY');
    });

    it('passes through to coderCall and returns its result as JSON', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: 'response text' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        });
        const ctx = makeCtx({ llm: { client, config: makeLlmConfig() } });

        const result = await coderTool.handler(
            { prompt: 'say something', system: 'be terse' },
            ctx
        );

        expect(result.isError).toBeFalsy();
        const text = result.content[0]?.text as string;
        const parsed = JSON.parse(text);
        expect(parsed.ok).toBe(true);
        expect(parsed.data.content).toBe('response text');
        expect(parsed.data.usage.total_tokens).toBe(8);

        // Verify the wrapper forwarded system + prompt to the agent.
        expect(client.calls[0].args.messages).toEqual([
            { role: 'system', content: 'be terse' },
            { role: 'user', content: 'say something' }
        ]);
    });

    it('marks result as error when agent returns ok=false', async () => {
        const client = makeMockClient();
        const err = new Error('boom') as any;
        err.status = 500;
        client.enqueueError(err);
        const ctx = makeCtx({ llm: { client, config: makeLlmConfig() } });

        const result = await coderTool.handler({ prompt: 'p' }, ctx);
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.kind).toBe('server_error');
    });

    it('coerces numeric args via Number() (defense in depth)', async () => {
        const client = makeMockClient();
        client.enqueueOk({
            model: 'MiniMax-M3',
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        });
        const ctx = makeCtx({ llm: { client, config: makeLlmConfig() } });

        // max_tokens and temperature arrive as strings (JSON parsers may differ).
        await coderTool.handler(
            { prompt: 'p', max_tokens: '128', temperature: '0.5' },
            ctx
        );

        expect(client.calls[0].args.max_tokens).toBe(128);
        expect(client.calls[0].args.temperature).toBe(0.5);
    });
});
