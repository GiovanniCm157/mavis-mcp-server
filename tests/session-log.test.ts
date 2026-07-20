/**
 * Tests for the session log (B-5).
 * Covers the SessionWriter, the read functions (list/get/tail/clear),
 * and the mavis_session_log tool wrapper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    SessionWriter,
    listSessions,
    readSessionEvents,
    tailSessionEvents,
    clearOldSessions,
    type SessionEvent
} from '../src/agents/session-log.js';
import { sessionLogTool } from '../src/tools/session-log.js';
import { createWorkspace } from '../src/workspace.js';
import { State } from '../src/state.js';
import type { ToolContext } from '../src/tools/types.js';

let workDir: string;
let logDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mavis-session-'));
    logDir = join(workDir, 'logs');
    mkdirSync(logDir, { recursive: true });
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
// SessionWriter
// ────────────────────────────────────────────────────────────

describe('SessionWriter', () => {
    it('writes events as JSONL', () => {
        const writer = new SessionWriter({
            dir: logDir,
            sessionId: 'sess-1',
            promptPrefix: 'test prompt'
        });
        writer.write({
            ts: '2026-07-20T10:00:00Z',
            session_id: 'sess-1',
            event: 'start',
            prompt: 'test prompt',
            model: 'MiniMax-M3',
            max_iterations: 20
        });
        writer.write({
            ts: '2026-07-20T10:00:01Z',
            session_id: 'sess-1',
            event: 'end',
            finish_reason: 'stop',
            iterations: 1,
            total_ms: 1000,
            final_content_preview: 'done',
            total_usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        });
        writer.close();

        const content = readFileSync(writer.getFilePath(), 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).event).toBe('start');
        expect(JSON.parse(lines[1]).event).toBe('end');
    });

    it('appends to existing file (does not truncate)', () => {
        const writer = new SessionWriter({ dir: logDir, sessionId: 's', promptPrefix: 'x' });
        writer.write({
            ts: '2026-07-20T10:00:00Z',
            session_id: 's',
            event: 'start', prompt: 'x', model: 'm', max_iterations: 1
        });
        writer.close();
        const file = writer.getFilePath();

        // Re-open same file (same session id + prompt prefix → same file name).
        const writer2 = new SessionWriter({ dir: logDir, sessionId: 's', promptPrefix: 'x' });
        writer2.write({
            ts: '2026-07-20T10:00:05Z',
            session_id: 's',
            event: 'end', finish_reason: 'stop', iterations: 1, total_ms: 100,
            final_content_preview: 'done', total_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        });
        writer2.close();

        const content = readFileSync(file, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        expect(lines).toHaveLength(2);
    });

    it('survives a write error (does not throw)', () => {
        const writer = new SessionWriter({ dir: logDir, sessionId: 's', promptPrefix: 'x' });
        // Close to prevent actual writes, but we still call write() —
        // it should be a no-op.
        writer.close();
        expect(() => writer.write({
            ts: '2026-07-20T10:00:00Z',
            session_id: 's',
            event: 'start', prompt: 'x', model: 'm', max_iterations: 1
        })).not.toThrow();
    });
});

// ────────────────────────────────────────────────────────────
// listSessions / readSessionEvents / tailSessionEvents
// ────────────────────────────────────────────────────────────

describe('session log read functions', () => {
    function writeFakeSession(filename: string, sessionId: string, prompt: string, when: Date): void {
        const path = join(logDir, filename);
        const lines: SessionEvent[] = [
            { ts: when.toISOString(), session_id: sessionId, event: 'start', prompt, model: 'MiniMax-M3', max_iterations: 20 },
            { ts: when.toISOString(), session_id: sessionId, event: 'end', finish_reason: 'stop', iterations: 1, total_ms: 100, final_content_preview: 'ok', total_usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
        ];
        writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    }

    it('listSessions returns empty when no files', () => {
        const result = listSessions(logDir, 10);
        expect(result).toEqual([]);
    });

    it('listSessions parses events and returns summary', () => {
        const when = new Date('2026-07-20T10:00:00Z');
        writeFakeSession('2026-07-20_10-00-00-abc12345.jsonl', 'sess-1', 'find bug in foo.js', when);
        const result = listSessions(logDir, 10);
        expect(result).toHaveLength(1);
        expect(result[0].session_id).toBe('sess-1');
        expect(result[0].prompt_preview).toBe('find bug in foo.js');
        expect(result[0].iterations).toBe(1);
        expect(result[0].finish_reason).toBe('stop');
    });

    it('listSessions sorts newest first', () => {
        writeFakeSession('2026-07-20_08-00-00-aaaaaaaa.jsonl', 'old', 'old prompt', new Date('2026-07-20T08:00:00Z'));
        writeFakeSession('2026-07-20_10-00-00-bbbbbbbb.jsonl', 'new', 'new prompt', new Date('2026-07-20T10:00:00Z'));
        const result = listSessions(logDir, 10);
        expect(result.map(s => s.session_id)).toEqual(['new', 'old']);
    });

    it('listSessions respects limit', () => {
        for (let i = 0; i < 5; i++) {
            writeFakeSession(`2026-07-20_08-00-${i.toString().padStart(2, '0')}-${i.toString().repeat(8)}.jsonl`, `s${i}`, `prompt ${i}`, new Date());
        }
        const result = listSessions(logDir, 3);
        expect(result).toHaveLength(3);
    });

    it('readSessionEvents returns all events', () => {
        const when = new Date();
        writeFakeSession('2026-07-20_10-00-00-cccccccc.jsonl', 's1', 'p', when);
        const events = readSessionEvents('2026-07-20_10-00-00-cccccccc.jsonl', logDir);
        expect(events).toHaveLength(2);
        expect(events[0].event).toBe('start');
        expect(events[1].event).toBe('end');
    });

    it('tailSessionEvents returns last N', () => {
        const path = join(logDir, 'test.jsonl');
        const events: SessionEvent[] = [
            { ts: '2026-07-20T10:00:00Z', session_id: 's', event: 'start', prompt: 'p', model: 'm', max_iterations: 20 },
            { ts: '2026-07-20T10:00:01Z', session_id: 's', event: 'iteration_start', iteration: 1 },
            { ts: '2026-07-20T10:00:02Z', session_id: 's', event: 'iteration_start', iteration: 2 },
            { ts: '2026-07-20T10:00:03Z', session_id: 's', event: 'iteration_start', iteration: 3 }
        ];
        writeFileSync(path, events.map(e => JSON.stringify(e)).join('\n') + '\n');
        const tailed = tailSessionEvents('test.jsonl', 2, logDir);
        expect(tailed).toHaveLength(2);
        expect((tailed[0] as any).iteration).toBe(2);
        expect((tailed[1] as any).iteration).toBe(3);
    });

    it('clearOldSessions deletes files older than maxAgeDays', () => {
        const oldPath = join(logDir, 'old.jsonl');
        const newPath = join(logDir, 'new.jsonl');
        writeFileSync(oldPath, '{}');
        writeFileSync(newPath, '{}');
        // Backdate old file to 60 days ago.
        const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        utimesSync(oldPath, oldDate, oldDate);
        // new file is current.

        const deleted = clearOldSessions(30, logDir);
        expect(deleted).toBe(1);
        expect(existsSync(oldPath)).toBe(false);
        expect(existsSync(newPath)).toBe(true);
    });
});

// ────────────────────────────────────────────────────────────
// mavis_session_log tool
// ────────────────────────────────────────────────────────────

describe('mavis_session_log (MCP tool wrapper)', () => {
    function makeCtx(): ToolContext {
        return {
            workspace: createWorkspace(workDir),
            state: new State(workDir)
        };
    }

    function writeFakeSession(filename: string, sessionId: string, prompt: string): void {
        const path = join(logDir, filename);
        const lines: SessionEvent[] = [
            { ts: '2026-07-20T10:00:00Z', session_id: sessionId, event: 'start', prompt, model: 'MiniMax-M3', max_iterations: 20 },
            { ts: '2026-07-20T10:00:01Z', session_id: sessionId, event: 'end', finish_reason: 'stop', iterations: 1, total_ms: 100, final_content_preview: 'ok', total_usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
        ];
        writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    }

    it('is registered with name mavis_session_log', () => {
        expect(sessionLogTool.name).toBe('mavis_session_log');
        expect(sessionLogTool.description).toBeTruthy();
        expect(sessionLogTool.inputSchema.required).toContain('action');
    });

    it('list action returns sessions in the default log dir', async () => {
        writeFakeSession('2026-07-20_10-00-00-dddddddd.jsonl', 's-list', 'test');
        const ctx = makeCtx();
        const result = await sessionLogTool.handler({ action: 'list' }, ctx);
        // We can't control the default dir here, so we just check the
        // shape: ok=true, data.log_dir + data.sessions are present.
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.ok).toBe(true);
        expect(parsed.data.log_dir).toBeDefined();
        expect(Array.isArray(parsed.data.sessions)).toBe(true);
    });

    it('get action requires session_id', async () => {
        const ctx = makeCtx();
        const result = await sessionLogTool.handler({ action: 'get' }, ctx);
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.kind).toBe('invalid_request');
    });

    it('get action returns not_found for unknown session', async () => {
        const ctx = makeCtx();
        const result = await sessionLogTool.handler(
            { action: 'get', session_id: 'nonexistent-id' },
            ctx
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.kind).toBe('not_found');
    });

    it('clear action reports deleted count', async () => {
        const ctx = makeCtx();
        const result = await sessionLogTool.handler(
            { action: 'clear', max_age_days: 1 },
            ctx
        );
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.ok).toBe(true);
        expect(parsed.data.deleted).toBeGreaterThanOrEqual(0);
    });

    it('rejects unknown action', async () => {
        const ctx = makeCtx();
        const result = await sessionLogTool.handler({ action: 'frobnicate' }, ctx);
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.kind).toBe('invalid_request');
    });

    it('coerces numeric args via Number() (defense in depth)', async () => {
        const ctx = makeCtx();
        const result = await sessionLogTool.handler(
            { action: 'list', limit: '5' } as any,
            ctx
        );
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.ok).toBe(true);
    });
});
