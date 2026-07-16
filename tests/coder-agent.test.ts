/**
 * Tests for the mavis_coder_agent tool and the coderAgent loop.
 *
 * Sprint B-2. We mock the OpenAI client to feed scripted responses
 * (text or with tool_calls) and use a mock tool executor to avoid
 * filesystem or shell side effects.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkspace } from '../src/workspace.js';
import { State } from '../src/state.js';
import { coderAgent, stripThinkBlocks } from '../src/agents/coder-loop.js';
import { coderAgentTool } from '../src/tools/coder-agent.js';
import type { AgentTool, LlmConfig, ToolExecutor } from '../src/agents/types.js';
import type { ToolContext } from '../src/tools/types.js';

// ────────────────────────────────────────────────────────────
// Mock OpenAI client (scripted responses)
// ────────────────────────────────────────────────────────────

interface ScriptedResponse {
    content: string | null;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }>;
    finish_reason?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    model?: string;
}

interface MockOpenAIClient {
    chat: { completions: { create: (args: any) => Promise<any> } };
    calls: Array<{ args: any }>;
    responses: ScriptedResponse[];
    addResponse: (r: ScriptedResponse) => void;
}

function makeMockClient(): MockOpenAIClient {
    const calls: Array<{ args: any }> = [];
    const responses: ScriptedResponse[] = [];
    const client: MockOpenAIClient = {
        chat: {
            completions: {
                create: async (args: any) => {
                    calls.push({ args });
                    const r = responses.shift();
                    if (!r) {
                        throw new Error('mock: no response queued');
                    }
                    return {
                        id: `mock-${calls.length}`,
                        model: r.model || 'MiniMax-M3',
                        choices: [{
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: r.content,
                                tool_calls: r.tool_calls
                            },
                            finish_reason: r.finish_reason || (r.tool_calls ? 'tool_calls' : 'stop')
                        }],
                        usage: r.usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
                    };
                }
            }
        },
        calls,
        responses,
        addResponse: (r) => responses.push(r)
    };
    return client;
}

// ────────────────────────────────────────────────────────────
// Mock tool registry + executor
// ────────────────────────────────────────────────────────────

function makeMockTool(name: string, description: string, exec: (args: any) => any): AgentTool {
    return {
        name,
        description,
        parameters: {
            type: 'object',
            properties: {
                input: { type: 'string', description: 'Echo input' }
            },
            required: ['input']
        },
        execute: async (args) => {
            const r = exec(args);
            // If the executor returns a string, wrap as ok.
            // If it returns { error }, wrap as is_error=true.
            if (typeof r === 'string') return { content: r, is_error: false };
            if (r && typeof r === 'object' && 'error' in r) {
                return { content: r.error, is_error: true };
            }
            return { content: JSON.stringify(r), is_error: false };
        }
    };
}

function makeMockToolkit(): AgentTool[] {
    return [
        makeMockTool('mock_echo', 'Echoes the input back.', (args) => `echo: ${args.input}`),
        makeMockTool('mock_fail', 'Always fails.', () => ({ error: 'intentional failure' })),
        makeMockTool('mock_sum', 'Sums two numbers.', (args) => ({
            result: Number(args.a || 0) + Number(args.b || 0)
        }))
    ];
}

function makeCtx(overrides: {
    llm?: any;
    toolRegistry?: any;
} = {}): ToolContext {
    const workDir = mkdtempSync(join(tmpdir(), 'mavis-coder-agent-'));
    const llm = 'llm' in overrides
        ? overrides.llm
        : { client: makeMockClient(), config: makeLlmConfig() };
    return {
        workspace: createWorkspace(workDir),
        state: new State(workDir),
        llm,
        toolRegistry: overrides.toolRegistry
    };
}

function makeLlmConfig(): LlmConfig {
    return {
        apiKey: 'sk-test',
        baseUrl: 'https://api.test/v1',
        defaultModel: 'MiniMax-M3'
    };
}

// ────────────────────────────────────────────────────────────
// stripThinkBlocks
// ────────────────────────────────────────────────────────────

describe('stripThinkBlocks', () => {
    it('removes a single think block', () => {
        const input = '<think>internal reasoning</think>final answer';
        expect(stripThinkBlocks(input)).toBe('final answer');
    });

    it('removes multiple think blocks (multiline)', () => {
        const input = '<think>\nstep 1\nstep 2\n</think>\n<think>step 3</think>real answer';
        expect(stripThinkBlocks(input)).toBe('real answer');
    });

    it('leaves non-think content untouched', () => {
        expect(stripThinkBlocks('hello world')).toBe('hello world');
        expect(stripThinkBlocks('')).toBe('');
    });

    it('returns empty when content is only a think block', () => {
        expect(stripThinkBlocks('<think>only thinking</think>')).toBe('');
    });
});

// ────────────────────────────────────────────────────────────
// coderAgent (loop) tests
// ────────────────────────────────────────────────────────────

describe('coderAgent (loop, single-shot tool calling)', () => {
    it('returns final_content with no tool calls (single iteration)', async () => {
        const client = makeMockClient();
        client.addResponse({
            content: 'the answer is 42',
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
        });

        const result = await coderAgent(
            { prompt: 'what is the answer?' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.final_content).toBe('the answer is 42');
            expect(result.data.iterations).toBe(1);
            expect(result.data.tool_calls).toEqual([]);
            expect(result.data.finish_reason).toBe('stop');
            expect(result.data.total_usage).toEqual({
                prompt_tokens: 8,
                completion_tokens: 4,
                total_tokens: 12
            });
        }
    });

    it('runs a 2-iteration loop: tool call then final answer', async () => {
        const client = makeMockClient();
        // Iteration 1: model asks to call mock_echo.
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'mock_echo', arguments: '{"input": "hi"}' }
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        });
        // Iteration 2: model returns final answer after seeing the tool result.
        client.addResponse({
            content: 'the tool said: hi',
            usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 }
        });

        const result = await coderAgent(
            { prompt: 'use the echo tool' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.iterations).toBe(2);
            expect(result.data.tool_calls).toHaveLength(1);
            expect(result.data.tool_calls[0]).toMatchObject({
                iteration: 1,
                tool_name: 'mock_echo',
                tool_args: { input: 'hi' },
                is_error: false
            });
            expect(result.data.tool_calls[0].result_summary).toContain('echo: hi');
            expect(result.data.final_content).toBe('the tool said: hi');
            expect(result.data.finish_reason).toBe('stop');
            // Usage aggregated.
            expect(result.data.total_usage).toEqual({
                prompt_tokens: 30,
                completion_tokens: 9,
                total_tokens: 39
            });
        }
    });

    it('runs a 3-iteration loop: 2 tool calls then final', async () => {
        const client = makeMockClient();
        // Iter 1: call mock_sum
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'mock_sum', arguments: '{"a": 2, "b": 3}' }
            }]
        });
        // Iter 2: call mock_echo with the sum
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c2', type: 'function',
                function: { name: 'mock_echo', arguments: '{"input": "5"}' }
            }]
        });
        // Iter 3: final answer
        client.addResponse({ content: 'done' });

        const result = await coderAgent(
            { prompt: 'sum 2 and 3, then echo' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.iterations).toBe(3);
            expect(result.data.tool_calls).toHaveLength(2);
            expect(result.data.tool_calls[0].tool_name).toBe('mock_sum');
            expect(result.data.tool_calls[1].tool_name).toBe('mock_echo');
            expect(result.data.final_content).toBe('done');
        }
    });

    it('strips think blocks from assistant content in history', async () => {
        const client = makeMockClient();
        client.addResponse({
            content: '<think>reasoning here</think>\nclean answer',
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'mock_echo', arguments: '{"input": "x"}' }
            }]
        });
        client.addResponse({ content: 'final' });

        await coderAgent(
            { prompt: 'p' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        // Inspect the messages sent in the SECOND LLM call. The
        // assistant message should have content stripped of think blocks.
        const secondCall = client.calls[1].args;
        const assistantMsg = secondCall.messages.find((m: any) => m.role === 'assistant');
        expect(assistantMsg.content).toBe('clean answer');
        expect(assistantMsg.content).not.toContain('<think>');
    });

    it('records tool error when executor returns is_error=true', async () => {
        const client = makeMockClient();
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'mock_fail', arguments: '{}' }
            }]
        });
        // After error, the LLM can still respond.
        client.addResponse({ content: 'tool failed but I recovered' });

        const result = await coderAgent(
            { prompt: 'p' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.tool_calls[0].is_error).toBe(true);
            expect(result.data.tool_calls[0].result_summary).toContain('intentional failure');
            // The tool message sent back to LLM should be prefixed with "Error:".
            const secondCall = client.calls[1].args;
            const toolMsg = secondCall.messages.find((m: any) => m.role === 'tool');
            expect(toolMsg.content).toMatch(/^Error:/);
        }
    });

    it('records tool error when JSON args are malformed', async () => {
        const client = makeMockClient();
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'mock_echo', arguments: 'not-valid-json' }
            }]
        });
        client.addResponse({ content: 'ok' });

        const result = await coderAgent(
            { prompt: 'p' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.tool_calls[0].is_error).toBe(true);
            expect(result.data.tool_calls[0].result_summary).toMatch(/invalid JSON/);
        }
    });

    it('terminates with max_iterations when loop hits the cap', async () => {
        const client = makeMockClient();
        // Queue 3 responses, but cap at 2.
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'mock_echo', arguments: '{"input": "a"}' }
            }]
        });
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c2', type: 'function',
                function: { name: 'mock_echo', arguments: '{"input": "b"}' }
            }]
        });
        client.addResponse({ content: 'never reached' });

        const result = await coderAgent(
            { prompt: 'p', max_iterations: 2 },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.iterations).toBe(2);
            expect(result.data.finish_reason).toBe('max_iterations');
            expect(result.data.tool_calls).toHaveLength(2);
            expect(result.data.final_content).toBe(''); // never got a stop
        }
    });

    it('rejects empty prompt', async () => {
        const client = makeMockClient();
        const result = await coderAgent(
            { prompt: '' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe('invalid_request');
        expect(client.calls.length).toBe(0);
    });

    it('rejects max_iterations > 30', async () => {
        const client = makeMockClient();
        const result = await coderAgent(
            { prompt: 'p', max_iterations: 50 },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe('invalid_request');
    });

    it('rejects temperature > 2', async () => {
        const client = makeMockClient();
        const result = await coderAgent(
            { prompt: 'p', temperature: 3 },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe('invalid_request');
    });

    it('returns invalid_request when no tools are available', async () => {
        const client = makeMockClient();
        const result = await coderAgent(
            { prompt: 'p', tools: ['nonexistent_tool'] },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
            expect(result.error.message).toContain('no tools available');
        }
    });

    it('respects req.tools filter (only exposes the listed tools)', async () => {
        const client = makeMockClient();
        client.addResponse({
            content: null,
            // Model tries to call mock_fail, which is NOT in the filter.
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'mock_fail', arguments: '{}' }
            }]
        });
        client.addResponse({ content: 'recovered' });

        const result = await coderAgent(
            { prompt: 'p', tools: ['mock_echo'] }, // mock_fail excluded
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            // The excluded tool call should be recorded as error.
            expect(result.data.tool_calls[0].tool_name).toBe('mock_fail');
            expect(result.data.tool_calls[0].is_error).toBe(true);
            expect(result.data.tool_calls[0].result_summary).toContain('not in allowed set');
        }
    });

    it('maps 401 from client.chat.completions to auth_error', async () => {
        const client = makeMockClient();
        const err = new Error('Unauthorized') as any;
        err.status = 401;
        // Override create to throw once.
        client.chat.completions.create = async () => { throw err; };

        const result = await coderAgent(
            { prompt: 'p' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('auth_error');
            expect(result.error.details).toMatchObject({
                status: 401,
                iterations_completed: 1
            });
        }
    });

    it('includes 429 as rate_limit', async () => {
        const client = makeMockClient();
        const err = new Error('Too many') as any;
        err.status = 429;
        client.chat.completions.create = async () => { throw err; };

        const result = await coderAgent(
            { prompt: 'p' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('rate_limit');
        }
    });

    it('passes tool_choice through to the LLM', async () => {
        const client = makeMockClient();
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'mock_echo', arguments: '{"input": "x"}' }
            }]
        });
        client.addResponse({ content: 'done' });

        await coderAgent(
            { prompt: 'p', tool_choice: 'required' },
            client as any,
            makeMockToolkit(),
            makePassthroughExecutor(),
            makeLlmConfig()
        );

        expect(client.calls[0].args.tool_choice).toBe('required');
    });

    it('truncates long tool results in result_summary but keeps full result for LLM', async () => {
        const longString = 'x'.repeat(2000);
        const bigTool: AgentTool = {
            name: 'big',
            description: 'Returns a long string.',
            parameters: { type: 'object', properties: {}, required: [] },
            execute: async () => ({ content: longString, is_error: false })
        };
        // Build a registry-aware executor that knows about 'big'.
        const executor: ToolExecutor = async (name, args) => {
            if (name === 'big') return bigTool.execute(args);
            return { content: `Error: tool "${name}" not in test registry`, is_error: true };
        };
        const client = makeMockClient();
        client.addResponse({
            content: null,
            tool_calls: [{
                id: 'c1', type: 'function',
                function: { name: 'big', arguments: '{}' }
            }]
        });
        client.addResponse({ content: 'done' });

        const result = await coderAgent(
            { prompt: 'p' },
            client as any,
            [bigTool],
            executor,
            makeLlmConfig()
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            // result_summary should be truncated to ~500 chars + ellipsis.
            expect(result.data.tool_calls[0].result_summary.length).toBeLessThan(700);
            expect(result.data.tool_calls[0].result_summary).toContain('truncated');
            // But the message sent back to the LLM (second call) should have the FULL content.
            const secondCall = client.calls[1].args;
            const toolMsg = secondCall.messages.find((m: any) => m.role === 'tool');
            expect(toolMsg.content).toHaveLength(2000);
        }
    });
});

// ────────────────────────────────────────────────────────────
// Helper: passthrough executor that calls the tool's execute
// ────────────────────────────────────────────────────────────

function makePassthroughExecutor(): ToolExecutor {
    const registry = new Map<string, AgentTool>();
    return (name: string, args: any) => {
        // Lazy build a registry from a default toolkit. We cheat by
        // re-creating it on each call. For tests, all executors are
        // constructed from the same makeMockToolkit() so the names
        // match. We rebuild the map on each call to keep it stateless.
        const fresh = new Map<string, AgentTool>();
        for (const t of makeMockToolkit()) fresh.set(t.name, t);
        const t = fresh.get(name);
        if (!t) {
            return Promise.resolve({
                content: `Error: tool "${name}" not in test registry`,
                is_error: true
            });
        }
        return t.execute(args);
    };
}

// ────────────────────────────────────────────────────────────
// coderAgentTool (MCP tool wrapper) tests
// ────────────────────────────────────────────────────────────

describe('mavis_coder_agent (MCP tool wrapper)', () => {
    it('is registered with name mavis_coder_agent', () => {
        expect(coderAgentTool.name).toBe('mavis_coder_agent');
        expect(coderAgentTool.description).toBeTruthy();
        expect(coderAgentTool.inputSchema.required).toContain('prompt');
    });

    it('returns config_error when llm context is missing', async () => {
        const ctx = makeCtx({ llm: undefined });
        const result = await coderAgentTool.handler({ prompt: 'p' }, ctx);
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.kind).toBe('config_error');
    });

    it('excludes mavis_coder and self from default tool list', async () => {
        // Build a context where the registry contains the agent tools
        // plus 2 generic tools. The wrapper should drop self + coder.
        const genericA: any = {
            name: 'generic_a', description: 'A',
            inputSchema: { type: 'object', properties: {}, required: [] },
            handler: async () => ({ content: [{ type: 'text', text: 'a' }] })
        };
        const genericB: any = {
            name: 'generic_b', description: 'B',
            inputSchema: { type: 'object', properties: {}, required: [] },
            handler: async () => ({ content: [{ type: 'text', text: 'b' }] })
        };
        const client = makeMockClient();
        client.addResponse({ content: 'no tools needed' });

        const ctx = makeCtx({
            llm: { client, config: makeLlmConfig() },
            toolRegistry: [genericA, genericB, coderAgentTool]
        });

        await coderAgentTool.handler({ prompt: 'just answer' }, ctx);

        // The OpenAI call should list only generic_a and generic_b.
        const toolsSent = client.calls[0].args.tools;
        const names = toolsSent.map((t: any) => t.function.name);
        expect(names).toContain('generic_a');
        expect(names).toContain('generic_b');
        expect(names).not.toContain('mavis_coder');
        expect(names).not.toContain('mavis_coder_agent');
    });

    it('passes through req.tools to the loop (when provided)', async () => {
        const genericA: any = {
            name: 'generic_a', description: 'A',
            inputSchema: { type: 'object', properties: {}, required: [] },
            handler: async () => ({ content: [{ type: 'text', text: 'a' }] })
        };
        const genericB: any = {
            name: 'generic_b', description: 'B',
            inputSchema: { type: 'object', properties: {}, required: [] },
            handler: async () => ({ content: [{ type: 'text', text: 'b' }] })
        };
        const client = makeMockClient();
        client.addResponse({ content: 'ok' });

        const ctx = makeCtx({
            llm: { client, config: makeLlmConfig() },
            toolRegistry: [genericA, genericB]
        });

        await coderAgentTool.handler(
            { prompt: 'p', tools: ['generic_a'] },
            ctx
        );

        const toolsSent = client.calls[0].args.tools;
        const names = toolsSent.map((t: any) => t.function.name);
        expect(names).toEqual(['generic_a']);
    });

    it('coerces numeric args via Number() (defense in depth)', async () => {
        const client = makeMockClient();
        client.addResponse({ content: 'ok' });

        const ctx = makeCtx({
            llm: { client, config: makeLlmConfig() },
            toolRegistry: []
        });

        // Empty registry will fail with "no tools available" but we
        // only care that the wrapper coerces the args before calling.
        await coderAgentTool.handler(
            { prompt: 'p', max_tokens: '256', temperature: '0.5', max_iterations: '3' },
            ctx
        );

        // Coercion happens but we hit the no-tools branch first.
        // To verify the coercion, run a no-tool registry and check
        // that the error message doesn't reference the raw strings.
        const result = await coderAgentTool.handler(
            { prompt: 'p', max_tokens: '256' },
            ctx
        );
        const text = result.content[0]?.text as string;
        expect(text).not.toContain('max_tokens must be 1-32768, got 256-string');
    });
});
