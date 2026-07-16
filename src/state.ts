/**
 * State — persistent per-workspace state for the MCP server.
 *
 * Stored at <workspace>/.mavis/state.json. Tracks:
 *   - Recent files touched (so Claude can re-read them efficiently)
 *   - Last command exit codes
 *   - Workspace metadata (created_at, last_used_at)
 *
 * State is optional — the server works without it. If the file is missing
 * or corrupt, we start fresh.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export interface MavisState {
    /** ISO timestamp of when the state was created. */
    created_at: string;
    /** ISO timestamp of the last tool call. */
    last_used_at: string;
    /** Files touched in reverse-chronological order. Most recent first. */
    recent_files: string[];
    /** Last N command exit codes (for debugging). */
    last_exit_codes: number[];
}

const STATE_FILENAME = '.mavis/state.json';
const MAX_RECENT_FILES = 50;
const MAX_EXIT_CODES = 20;

export class State {
    private state: MavisState;
    private statePath: string;
    private dirty = false;

    constructor(workspaceRoot: string) {
        this.statePath = join(workspaceRoot, STATE_FILENAME);
        this.state = this.load();
    }

    private load(): MavisState {
        if (!existsSync(this.statePath)) {
            return this.fresh();
        }
        try {
            const raw = readFileSync(this.statePath, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                created_at: parsed.created_at || new Date().toISOString(),
                last_used_at: parsed.last_used_at || new Date().toISOString(),
                recent_files: Array.isArray(parsed.recent_files) ? parsed.recent_files : [],
                last_exit_codes: Array.isArray(parsed.last_exit_codes) ? parsed.last_exit_codes : []
            };
        } catch {
            // Corrupt or unreadable. Start fresh.
            return this.fresh();
        }
    }

    private fresh(): MavisState {
        const now = new Date().toISOString();
        return {
            created_at: now,
            last_used_at: now,
            recent_files: [],
            last_exit_codes: []
        };
    }

    /**
     * Record that a file was touched (read, written, or edited).
     * Most recent first, deduped, capped at MAX_RECENT_FILES.
     */
    recordFile(filePath: string): void {
        const absolute = filePath;
        this.state.recent_files = [
            absolute,
            ...this.state.recent_files.filter(f => f !== absolute)
        ].slice(0, MAX_RECENT_FILES);
        this.touch();
    }

    /**
     * Record the exit code of a command.
     */
    recordExitCode(code: number): void {
        this.state.last_exit_codes = [
            code,
            ...this.state.last_exit_codes
        ].slice(0, MAX_EXIT_CODES);
        this.touch();
    }

    /**
     * Update last_used_at.
     */
    private touch(): void {
        this.state.last_used_at = new Date().toISOString();
        this.dirty = true;
    }

    /**
     * Get a snapshot of the current state (read-only).
     */
    snapshot(): Readonly<MavisState> {
        return { ...this.state };
    }

    /**
     * Persist state to disk. Idempotent if no changes since last save.
     */
    save(): void {
        if (!this.dirty) return;
        const dir = dirname(this.statePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
        this.dirty = false;
    }
}
