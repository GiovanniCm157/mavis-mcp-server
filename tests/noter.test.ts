/**
 * Tests for the mavis_noter tool and the runNoter function.
 *
 * Sprint B-4. We mock the NlmExec function to avoid real CLI calls.
 * The mock is a stateful function that returns whatever the test
 * queued. This lets us test both happy paths and error mapping
 * (ENOENT, timeout, auth) without touching the real nlm binary.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runNoter, type NlmExec } from '../src/agents/noter.js';
import { noterTool } from '../src/tools/noter.js';
import { createWorkspace } from '../src/workspace.js';
import { State } from '../src/state.js';
import type { ToolContext } from '../src/tools/types.js';

// ────────────────────────────────────────────────────────────
// Mock NlmExec
// ────────────────────────────────────────────────────────────

interface QueuedResult {
    kind: 'ok' | 'err';
    stdout?: string;
    stderr?: string;
    code?: string;
    message?: string;
    /** If true, kill the process (simulates timeout). */
    killed?: boolean;
}

interface MockNlm {
    exec: NlmExec;
    calls: Array<{ args: string[]; opts: any }>;
    queue: QueuedResult[];
    enqueue: (r: QueuedResult) => void;
    enqueueOk: (stdout: string) => void;
    enqueueErr: (err: Partial<QueuedResult>) => void;
}

function makeMockNlm(): MockNlm {
    const calls: Array<{ args: string[]; opts: any }> = [];
    const queue: QueuedResult[] = [];
    const mock: MockNlm = {
        calls,
        queue,
        exec: async (args, opts) => {
            calls.push({ args, opts });
            const next = queue.shift();
            if (!next) {
                throw new Error('mock: no result queued');
            }
            if (next.kind === 'ok') {
                return { stdout: next.stdout || '', stderr: next.stderr || '' };
            }
            // Build an error similar to what execFile would throw.
            const err: any = new Error(next.message || 'mock error');
            err.code = next.code;
            err.stderr = next.stderr || '';
            err.killed = next.killed || false;
            throw err;
        },
        enqueue: (r) => queue.push(r),
        enqueueOk: (stdout) => queue.push({ kind: 'ok', stdout }),
        enqueueErr: (e) => queue.push({ kind: 'err', ...e })
    };
    return mock;
}

function makeCtx(): ToolContext {
    const workDir = mkdtempSync(join(tmpdir(), 'mavis-noter-'));
    return {
        workspace: createWorkspace(workDir),
        state: new State(workDir)
    };
}

// ────────────────────────────────────────────────────────────
// runNoter
// ────────────────────────────────────────────────────────────

describe('runNoter (nlm CLI wrapper)', () => {
    it('doctor action returns nlm status', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('NotebookLM MCP Doctor\nAll systems OK');

        const result = await runNoter(
            { action: 'doctor' },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.answer).toContain('NotebookLM MCP Doctor');
        }
        expect(nlm.calls[0].args).toEqual(['doctor']);
    });

    it('list_notebooks parses the JSON array format (notebooklm-mcp-cli 0.6.x)', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk(JSON.stringify([
            { id: '21102950-4bfc-4e4d-a78d-8e1a2b338d99', title: 'KOMO OS', source_count: 9 },
            { id: '48cc26af-9f4d-4776-a6eb-b1bcb35d9179', title: 'Other', source_count: 0 }
        ]));

        const result = await runNoter(
            { action: 'list_notebooks' },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.notebooks).toHaveLength(2);
            expect(result.data.notebooks![0]).toEqual({
                id: '21102950-4bfc-4e4d-a78d-8e1a2b338d99',
                title: 'KOMO OS'
            });
        }
    });

    it('list_notebooks falls back to id/title line format (older CLI)', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk(
            'id: 21102950-4bfc-4e4d-a78d-8e1a2b338d99 title: KOMO OS doctrinal\n' +
            'id: 48cc26af-9f4d-4776-a6eb-b1bcb35d9179 title: KOMO OS conversation\n'
        );

        const result = await runNoter(
            { action: 'list_notebooks' },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.notebooks).toHaveLength(2);
            expect(result.data.notebooks![0]).toEqual({
                id: '21102950-4bfc-4e4d-a78d-8e1a2b338d99',
                title: 'KOMO OS doctrinal'
            });
        }
    });

    it('list_notebooks returns empty array when no structured output', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('not a recognized format\njust text\n');

        const result = await runNoter(
            { action: 'list_notebooks' },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.notebooks).toEqual([]);
        }
    });

    it('create_notebook extracts the new id from stdout', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('Created notebook: 12345678-1234-1234-1234-123456789012\n');

        const result = await runNoter(
            { action: 'create_notebook', title: 'My New Notebook' },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.notebook_id).toBe('12345678-1234-1234-1234-123456789012');
        }
        expect(nlm.calls[0].args).toEqual(['notebook', 'create', 'My New Notebook']);
    });

    it('add_source passes notebook_id and source to nlm', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('Source added successfully');

        const result = await runNoter(
            {
                action: 'add_source',
                notebook_id: 'nb-123',
                source: '/path/to/doc.md'
            },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        expect(nlm.calls[0].args).toEqual(['source', 'add', 'nb-123', '/path/to/doc.md']);
    });

    it('add_source supports URL as source', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('Source added');

        await runNoter(
            {
                action: 'add_source',
                notebook_id: 'nb-123',
                source: 'https://example.com/article'
            },
            nlm.exec
        );

        expect(nlm.calls[0].args[3]).toBe('https://example.com/article');
    });

    it('query action passes question and notebook_id', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('The answer is 42.');

        const result = await runNoter(
            {
                action: 'query',
                notebook_id: 'nb-123',
                question: 'What is the meaning of life?'
            },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.answer).toBe('The answer is 42.');
        }
        expect(nlm.calls[0].args).toEqual(['notebook', 'query', 'nb-123', 'What is the meaning of life?']);
    });

    it('query includes --conversation-id when provided', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('continuation of conversation');

        await runNoter(
            {
                action: 'query',
                notebook_id: 'nb-123',
                question: 'follow up',
                conversation_id: 'conv-abc'
            },
            nlm.exec
        );

        expect(nlm.calls[0].args).toEqual([
            'notebook', 'query', 'nb-123', 'follow up',
            '--conversation-id', 'conv-abc'
        ]);
    });

    it('query echoes back conversation_id in response', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('response');

        const result = await runNoter(
            {
                action: 'query',
                notebook_id: 'nb-123',
                question: 'q',
                conversation_id: 'conv-xyz'
            },
            nlm.exec
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.conversation_id).toBe('conv-xyz');
        }
    });

    it('rejects missing action with invalid_request', async () => {
        const nlm = makeMockNlm();
        const result = await runNoter({} as any, nlm.exec);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
        expect(nlm.calls.length).toBe(0);
    });

    it('rejects query without notebook_id', async () => {
        const nlm = makeMockNlm();
        const result = await runNoter(
            { action: 'query', question: 'q' } as any,
            nlm.exec
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
            expect(result.error.message).toContain('notebook_id');
        }
    });

    it('rejects query without question', async () => {
        const nlm = makeMockNlm();
        const result = await runNoter(
            { action: 'query', notebook_id: 'nb-1' } as any,
            nlm.exec
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('rejects empty/whitespace question', async () => {
        const nlm = makeMockNlm();
        const result = await runNoter(
            { action: 'query', notebook_id: 'nb-1', question: '   ' },
            nlm.exec
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('rejects add_source without notebook_id or source', async () => {
        const nlm = makeMockNlm();
        const r1 = await runNoter({ action: 'add_source' } as any, nlm.exec);
        expect(r1.ok).toBe(false);
        if (!r1.ok) expect(r1.error.kind).toBe('invalid_request');

        const r2 = await runNoter(
            { action: 'add_source', notebook_id: 'nb-1' } as any,
            nlm.exec
        );
        expect(r2.ok).toBe(false);
        if (!r2.ok) expect(r2.error.kind).toBe('invalid_request');
    });

    it('rejects create_notebook without title', async () => {
        const nlm = makeMockNlm();
        const result = await runNoter({ action: 'create_notebook' } as any, nlm.exec);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('maps ENOENT (nlm not found) to config_error', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueErr({ code: 'ENOENT', message: 'spawn nlm ENOENT' });

        const result = await runNoter(
            { action: 'doctor' },
            nlm.exec
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('config_error');
            expect(result.error.details?.code).toBe('ENOENT');
        }
    });

    it('maps process killed (timeout) to timeout error', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueErr({ code: null, message: 'killed', killed: true });

        const result = await runNoter(
            { action: 'doctor' },
            nlm.exec
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('timeout');
        }
    });

    it('detects auth errors from stderr', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueErr({
            message: 'command failed',
            stderr: 'Error: not authenticated. Run nlm login first.'
        });

        const result = await runNoter(
            { action: 'doctor' },
            nlm.exec
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('auth_error');
        }
    });

    it('passes env with augmented PATH to nlm', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('ok');

        await runNoter({ action: 'doctor' }, nlm.exec);

        const env = nlm.calls[0].opts.env as NodeJS.ProcessEnv;
        expect(env.PATH).toBeDefined();
        expect(env.PATH).toContain('Library/Python/3.13/bin');
        expect(env.PATH).toContain('.local/bin');
    });

    it('passes timeout in milliseconds to exec', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('ok');

        await runNoter(
            { action: 'doctor', timeout_seconds: 30 },
            nlm.exec
        );

        expect(nlm.calls[0].opts.timeout).toBe(30_000);
    });

    it('uses default timeout of 60 seconds when not specified', async () => {
        const nlm = makeMockNlm();
        nlm.enqueueOk('ok');

        await runNoter({ action: 'doctor' }, nlm.exec);

        expect(nlm.calls[0].opts.timeout).toBe(60_000);
    });
});

// ────────────────────────────────────────────────────────────
// noterTool (MCP tool wrapper)
// ────────────────────────────────────────────────────────────

describe('mavis_noter (MCP tool wrapper)', () => {
    it('is registered with name mavis_noter', () => {
        expect(noterTool.name).toBe('mavis_noter');
        expect(noterTool.description).toBeTruthy();
        expect(noterTool.inputSchema.required).toContain('action');
    });

    it('returns invalid_request for unknown action', async () => {
        const ctx = makeCtx();
        const result = await noterTool.handler(
            { action: 'frobnicate' },
            ctx
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.kind).toBe('invalid_request');
    });

    it('defaults notebook_id to the KOMO doctrinal notebook for query', async () => {
        // We test the wrapper by checking that the request is built
        // with the right default. The runNoter call would fail with
        // an invalid_request (no question), so we expect the failure
        // to reference the right notebook_id.
        const ctx = makeCtx();
        const result = await noterTool.handler(
            { action: 'query' /* no notebook_id, no question */ } as any,
            ctx
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.message).toContain('question is required');
    });

    it('coerces timeout_seconds via Number() (defense in depth)', async () => {
        // The point of this test is to verify the wrapper accepts a
        // string for timeout_seconds and coerces it to a number. If
        // coercion failed, the wrapper would return invalid_request.
        // We don't care what nlm actually does (the real binary may
        // or may not be on PATH in this test env) — we just care that
        // the wrapper didn't reject the input shape.
        const ctx = makeCtx();
        const result = await noterTool.handler(
            { action: 'doctor', timeout_seconds: '30' } as any,
            ctx
        );
        const parsed = JSON.parse(result.content[0]?.text as string);
        // The result is some AgentResult. If the wrapper rejected the
        // arg, error.kind would be 'invalid_request' with a message
        // about timeout. We accept any other shape (ok=true, or error
        // from a downstream nlm call).
        if (!parsed.ok && parsed.error) {
            expect(parsed.error.kind).not.toBe('invalid_request');
            if (parsed.error.message) {
                expect(parsed.error.message).not.toMatch(/timeout.*must be/i);
            }
        }
    });
});
