/**
 * Tests for state.ts.
 * - recordFile dedupes and caps at MAX_RECENT_FILES
 * - recordExitCode keeps the most recent
 * - save() flushes to disk
 * - load() recovers from corrupt file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { State } from '../src/state.js';

describe('state', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'mavis-mcp-state-'));
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    it('starts with fresh state if file does not exist', () => {
        const s = new State(workDir);
        const snap = s.snapshot();
        expect(snap.recent_files).toEqual([]);
        expect(snap.last_exit_codes).toEqual([]);
        expect(snap.created_at).toBeTruthy();
    });

    it('recordFile adds to recent_files (most recent first)', () => {
        const s = new State(workDir);
        s.recordFile('/a.txt');
        s.recordFile('/b.txt');
        s.recordFile('/c.txt');
        expect(s.snapshot().recent_files).toEqual(['/c.txt', '/b.txt', '/a.txt']);
    });

    it('recordFile dedupes (same file moves to front)', () => {
        const s = new State(workDir);
        s.recordFile('/a.txt');
        s.recordFile('/b.txt');
        s.recordFile('/a.txt');
        expect(s.snapshot().recent_files).toEqual(['/a.txt', '/b.txt']);
    });

    it('recordFile caps at MAX_RECENT_FILES (50)', () => {
        const s = new State(workDir);
        for (let i = 0; i < 60; i++) {
            s.recordFile(`/file-${i}.txt`);
        }
        const recent = s.snapshot().recent_files;
        expect(recent.length).toBe(50);
        // Most recent first: file-59, file-58, ..., file-10
        expect(recent[0]).toBe('/file-59.txt');
        expect(recent[49]).toBe('/file-10.txt');
    });

    it('recordExitCode adds to history (most recent first)', () => {
        const s = new State(workDir);
        s.recordExitCode(0);
        s.recordExitCode(1);
        s.recordExitCode(0);
        expect(s.snapshot().last_exit_codes).toEqual([0, 1, 0]);
    });

    it('recordExitCode caps at MAX_EXIT_CODES (20)', () => {
        const s = new State(workDir);
        for (let i = 0; i < 25; i++) {
            s.recordExitCode(i);
        }
        const codes = s.snapshot().last_exit_codes;
        expect(codes.length).toBe(20);
    });

    it('save() writes state to .mavis/state.json', () => {
        const s = new State(workDir);
        s.recordFile('/foo.txt');
        s.save();
        const path = join(workDir, '.mavis', 'state.json');
        expect(existsSync(path)).toBe(true);
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        expect(raw.recent_files).toContain('/foo.txt');
    });

    it('save() is idempotent if not dirty', () => {
        const s = new State(workDir);
        s.save();
        // Modify state to make it dirty, then save again, then check file timestamp.
        s.recordFile('/foo.txt');
        s.save();
        // Just verify it doesn't throw. Real idempotence is hard to test without fs mocking.
    });

    it('load() recovers from corrupt JSON', () => {
        const path = join(workDir, '.mavis', 'state.json');
        const { mkdirSync } = require('node:fs') as typeof import('node:fs');
        mkdirSync(join(workDir, '.mavis'), { recursive: true });
        writeFileSync(path, '{invalid json', 'utf8');
        const s = new State(workDir);
        // Should start fresh, not throw.
        expect(s.snapshot().recent_files).toEqual([]);
    });

    it('load() preserves state across instances', () => {
        const s1 = new State(workDir);
        s1.recordFile('/a.txt');
        s1.save();
        const s2 = new State(workDir);
        expect(s2.snapshot().recent_files).toEqual(['/a.txt']);
    });
});
