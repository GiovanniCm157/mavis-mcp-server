/**
 * Mavis Session Log — JSONL writer/reader for agent run traces.
 *
 * Sprint B-5. Each agent run writes events to ~/.mavis-mcp/agent-sessions/
 * as JSONL (one event per line, append-only). This gives us:
 *   - Persistent "flight recorder" for post-mortem analysis
 *   - Live tail -f while a session is running
 *   - Programmatic access via the mavis_session_log tool
 *
 * File naming: {timestamp}-{short-id}.jsonl where the short-id is a
 * hash of the prompt prefix (so files sort chronologically AND are
 * groupable by similar prompts).
 *
 * Design notes:
 *   - Pure functions for read. A class for write (manages file handle).
 *   - Append-only writes; we never modify a session file in place.
 *   - The writer uses fs.appendFileSync (sync) so events are flushed
 *     immediately. Latency is negligible (~0.1ms per event) and we
 *     don't want to lose events on crash.
 *   - The directory is auto-created on first write (mkdir -p).
 *   - Retention: sessions older than 30 days are listed but not auto-deleted
 *     (the mavis_session_log tool has a 'clear' action for explicit cleanup).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

// ────────────────────────────────────────────────────────────
// Paths
// ────────────────────────────────────────────────────────────

/**
 * Where session logs live. Honors $MAVIS_SESSION_LOG_DIR if set,
 * otherwise defaults to ~/.mavis-mcp/agent-sessions/.
 */
export function defaultSessionLogDir(): string {
    if (process.env.MAVIS_SESSION_LOG_DIR) {
        return process.env.MAVIS_SESSION_LOG_DIR;
    }
    return join(homedir(), '.mavis-mcp', 'agent-sessions');
}

// ────────────────────────────────────────────────────────────
// Event types
// ────────────────────────────────────────────────────────────

export type SessionEvent =
    | { ts: string; session_id: string; event: 'start'; prompt: string; system?: string; model: string; max_iterations: number }
    | { ts: string; session_id: string; event: 'iteration_start'; iteration: number }
    | { ts: string; session_id: string; event: 'llm_call'; iteration: number; latency_ms: number; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; finish_reason: string }
    | { ts: string; session_id: string; event: 'tool_call'; iteration: number; tool_name: string; tool_args: Record<string, any>; tool_call_id: string }
    | { ts: string; session_id: string; event: 'tool_result'; iteration: number; tool_call_id: string; tool_name: string; result_summary: string; is_error: boolean; duration_ms: number }
    | { ts: string; session_id: string; event: 'iteration_end'; iteration: number; had_tool_calls: boolean }
    | { ts: string; session_id: string; event: 'end'; finish_reason: 'stop' | 'max_iterations' | 'length' | 'content_filter' | 'error'; iterations: number; total_ms: number; final_content_preview: string; total_usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
    | { ts: string; session_id: string; event: 'error'; message: string };

// ────────────────────────────────────────────────────────────
// SessionWriter — append-only JSONL writer
// ────────────────────────────────────────────────────────────

export class SessionWriter {
    private readonly filePath: string;
    private readonly sessionId: string;
    private closed = false;

    constructor(opts: { dir?: string; sessionId: string; promptPrefix: string }) {
        const dir = opts.dir || defaultSessionLogDir();
        mkdirSync(dir, { recursive: true });

        this.sessionId = opts.sessionId;

        // File name: {ISO-date}-{short-prompt-hash}.jsonl
        // Sortable by date, groupable by prompt prefix.
        const now = new Date();
        const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
        const promptHash = shortHash(opts.promptPrefix);
        this.filePath = join(dir, `${stamp}-${promptHash}.jsonl`);
    }

    /**
     * Write an event. Synchronous to guarantee flush before crash.
     */
    write(event: SessionEvent): void {
        if (this.closed) return;
        try {
            writeFileSync(this.filePath, JSON.stringify(event) + '\n', { flag: 'a' });
        } catch (err) {
            // Don't crash the agent loop on log write failure.
            process.stderr.write(`[mavis-mcp] session log write failed: ${err}\n`);
        }
    }

    getFilePath(): string {
        return this.filePath;
    }

    getSessionId(): string {
        return this.sessionId;
    }

    close(): void {
        this.closed = true;
    }
}

// ────────────────────────────────────────────────────────────
// SessionReader — read & parse JSONL files
// ────────────────────────────────────────────────────────────

export interface SessionSummary {
    session_id: string;
    file: string;
    started_at: string;
    ended_at?: string;
    prompt_preview: string;
    model?: string;
    iterations: number;
    finish_reason?: string;
    total_ms?: number;
    total_usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    file_size: number;
}

/**
 * List session files in the log dir, newest first.
 */
export function listSessions(dir?: string, limit = 50): SessionSummary[] {
    const logDir = dir || defaultSessionLogDir();
    let entries: string[];
    try {
        entries = readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
    } catch {
        return []; // dir doesn't exist
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
        const full = join(logDir, entry);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        const events = readEvents(full);
        const start = events.find(e => e.event === 'start');
        const end = events.find(e => e.event === 'end');
        if (!start) continue;

        summaries.push({
            session_id: start.session_id,
            file: basename(full),
            started_at: start.ts,
            ended_at: end?.ts,
            prompt_preview: (start as any).prompt?.slice(0, 100) || '',
            model: (start as any).model,
            iterations: (end as any)?.iterations ?? events.filter(e => e.event === 'iteration_start').length,
            finish_reason: (end as any)?.finish_reason,
            total_ms: (end as any)?.total_ms,
            total_usage: (end as any)?.total_usage,
            file_size: st.size
        });
    }

    // Sort newest first.
    summaries.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return summaries.slice(0, limit);
}

/**
 * Read all events from a session file. Returns the array.
 */
export function readSessionEvents(file: string, dir?: string): SessionEvent[] {
    const logDir = dir || defaultSessionLogDir();
    const full = file.includes('/') ? file : join(logDir, file);
    return readEvents(full);
}

/**
 * Read last N events from a session file (most recent first by line order).
 */
export function tailSessionEvents(file: string, n: number, dir?: string): SessionEvent[] {
    const all = readSessionEvents(file, dir);
    return all.slice(-n);
}

function readEvents(filePath: string): SessionEvent[] {
    let content: string;
    try {
        content = readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }
    const events: SessionEvent[] = [];
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
            events.push(JSON.parse(line));
        } catch {
            // Skip malformed lines (defensive).
        }
    }
    return events;
}

/**
 * Delete session files older than `maxAgeDays` days. Returns count deleted.
 */
export function clearOldSessions(maxAgeDays: number, dir?: string): number {
    const logDir = dir || defaultSessionLogDir();
    let entries: string[];
    try {
        entries = readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
    } catch {
        return 0;
    }
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const entry of entries) {
        const full = join(logDir, entry);
        try {
            const st = statSync(full);
            if (st.mtimeMs < cutoff) {
                unlinkSync(full);
                deleted++;
            }
        } catch {
            // ignore
        }
    }
    return deleted;
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/**
 * Short non-cryptographic hash for filename grouping. djb2 variant.
 * Deterministic across runs so similar prompts land in adjacent files.
 */
function shortHash(input: string): string {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    }
    // Convert to unsigned 32-bit hex, 8 chars.
    return (hash >>> 0).toString(16).padStart(8, '0');
}
