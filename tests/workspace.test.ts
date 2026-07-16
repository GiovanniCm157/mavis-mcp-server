/**
 * Tests for workspace.ts.
 * - resolve() correctly handles cwd within workspace
 * - resolve() blocks path-escape attacks
 * - contains() works for absolute paths inside and outside
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createWorkspace, workspaceFromEnv, WorkspaceError } from '../src/workspace.js';

describe('workspace', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'mavis-mcp-test-'));
        mkdirSync(join(workDir, 'sub'), { recursive: true });
        writeFileSync(join(workDir, 'sub', 'file.txt'), 'hello');
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    it('createWorkspace: accepts an existing directory', () => {
        const ws = createWorkspace(workDir);
        expect(ws.root).toBe(workDir);
    });

    it('createWorkspace: rejects non-existent path', () => {
        expect(() => createWorkspace('/does/not/exist/anywhere')).toThrow(WorkspaceError);
    });

    it('createWorkspace: rejects a file (not a directory)', () => {
        const filePath = join(workDir, 'sub', 'file.txt');
        expect(() => createWorkspace(filePath)).toThrow(WorkspaceError);
    });

    it('resolve: undefined cwd returns root', () => {
        const ws = createWorkspace(workDir);
        expect(ws.resolve()).toBe(workDir);
    });

    it('resolve: "." returns root', () => {
        const ws = createWorkspace(workDir);
        expect(ws.resolve('.')).toBe(workDir);
    });

    it('resolve: relative cwd is resolved against root', () => {
        const ws = createWorkspace(workDir);
        expect(ws.resolve('sub')).toBe(join(workDir, 'sub'));
    });

    it('resolve: absolute path within workspace is allowed', () => {
        const ws = createWorkspace(workDir);
        const abs = join(workDir, 'sub', 'file.txt');
        expect(ws.resolve(abs)).toBe(abs);
    });

    it('resolve: absolute path OUTSIDE workspace is rejected', () => {
        const ws = createWorkspace(workDir);
        const outside = join(workDir, '..', 'etc', 'passwd');
        expect(() => ws.resolve(outside)).toThrow(WorkspaceError);
    });

    it('resolve: relative path with .. that escapes is rejected', () => {
        const ws = createWorkspace(workDir);
        expect(() => ws.resolve('../etc')).toThrow(WorkspaceError);
    });

    it('contains: returns true for root', () => {
        const ws = createWorkspace(workDir);
        expect(ws.contains(workDir)).toBe(true);
    });

    it('contains: returns true for paths inside', () => {
        const ws = createWorkspace(workDir);
        expect(ws.contains(join(workDir, 'sub', 'file.txt'))).toBe(true);
    });

    it('contains: returns false for sibling paths', () => {
        const ws = createWorkspace(workDir);
        const sibling = workDir + '-other';
        expect(ws.contains(sibling)).toBe(false);
    });

    it('contains: returns false for parent paths (prefix collision safe)', () => {
        const ws = createWorkspace(workDir);
        // workDir + 'extra' would be a sibling; should not be considered inside
        expect(ws.contains(workDir + 'extra')).toBe(false);
    });

    describe('workspaceFromEnv', () => {
        const originalEnv = process.env.MAVIS_WORKSPACE;

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env.MAVIS_WORKSPACE;
            } else {
                process.env.MAVIS_WORKSPACE = originalEnv;
            }
        });

        it('throws if MAVIS_WORKSPACE is not set', () => {
            delete process.env.MAVIS_WORKSPACE;
            expect(() => workspaceFromEnv()).toThrow(WorkspaceError);
        });

        it('uses MAVIS_WORKSPACE when set', () => {
            process.env.MAVIS_WORKSPACE = workDir;
            const ws = workspaceFromEnv();
            expect(ws.root).toBe(workDir);
        });
    });
});
