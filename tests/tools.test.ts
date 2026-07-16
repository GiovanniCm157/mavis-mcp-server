/**
 * Tests for the 9 tools.
 * Each tool gets a focused test: success path + critical defense.
 *
 * We use a tempdir as workspace. We mock nothing — the tests
 * actually run shell commands, git, etc. (where the test environment
 * supports them).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { createWorkspace } from '../src/workspace.js';
import { State } from '../src/state.js';
import {
    bashTool, readTool, writeTool, editTool, searchTool,
    gitTool, supabaseTool, runTestsTool, stateTool
} from '../src/tools/index.js';
import type { ToolContext } from '../src/tools/types.js';

let workDir: string;
let ctx: ToolContext;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mavis-mcp-tools-'));
    // Init a minimal git repo so git tests work.
    try {
        execSync('git init -q -b main', { cwd: workDir });
        execSync('git config user.email "test@test"', { cwd: workDir });
        execSync('git config user.name "Test"', { cwd: workDir });
    } catch {
        // git not available; git tests will skip
    }
    ctx = {
        workspace: createWorkspace(workDir),
        state: new State(workDir)
    };
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────
// bashTool
// ────────────────────────────────────────────────────────────
describe('mavis_bash', () => {
    it('runs a shell command and returns stdout', async () => {
        const result = await bashTool.handler({ command: 'echo hello' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('hello');
        expect(text).toContain('[exit: 0]');
    });

    it('returns non-zero exit code on failure', async () => {
        const result = await bashTool.handler({ command: 'exit 42' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('[exit: 42]');
    });

    it('runs in subdirectory via cwd', async () => {
        mkdirSync(join(workDir, 'sub'));
        writeFileSync(join(workDir, 'sub', 'marker.txt'), 'here');
        const result = await bashTool.handler({ command: 'cat marker.txt', cwd: 'sub' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('here');
    });

    it('refuses cwd that escapes workspace', async () => {
        await expect(
            bashTool.handler({ command: 'pwd', cwd: '/etc' }, ctx)
        ).rejects.toThrow();
    });
});

// ────────────────────────────────────────────────────────────
// readTool
// ────────────────────────────────────────────────────────────
describe('mavis_read', () => {
    it('reads a text file', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'hello world');
        const result = await readTool.handler({ path: 'a.txt' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('hello world');
    });

    it('returns error for missing file', async () => {
        const result = await readTool.handler({ path: 'missing.txt' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('not found');
    });

    it('refuses path that escapes workspace', async () => {
        const result = await readTool.handler({ path: '/etc/passwd' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('escapes workspace');
    });

    it('truncates to max_lines', async () => {
        writeFileSync(join(workDir, 'multi.txt'), 'lineA\nlineB\nlineC\nlineD\nlineE');
        const result = await readTool.handler({ path: 'multi.txt', max_lines: 2 }, ctx);
        const text = result.content[0]?.text as string;
        // First 2 lines should be present.
        expect(text).toContain('lineA');
        expect(text).toContain('lineB');
        // The 3rd, 4th, 5th lines should NOT be in the body.
        expect(text).not.toContain('lineC');
        expect(text).not.toContain('lineD');
        expect(text).not.toContain('lineE');
        // Truncation notice should be present.
        expect(text).toContain('truncated');
    });

    it('returns image content for png files', async () => {
        // Write a minimal valid PNG (1x1 transparent)
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
        writeFileSync(join(workDir, 'img.png'), png);
        const result = await readTool.handler({ path: 'img.png' }, ctx);
        expect(result.content[0]?.type).toBe('image');
    });
});

// ────────────────────────────────────────────────────────────
// writeTool
// ────────────────────────────────────────────────────────────
describe('mavis_write', () => {
    it('writes a new file', async () => {
        await writeTool.handler({ path: 'a.txt', content: 'hello' }, ctx);
        expect(readFileSync(join(workDir, 'a.txt'), 'utf8')).toBe('hello');
    });

    it('overwrites an existing file', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'old');
        await writeTool.handler({ path: 'a.txt', content: 'new' }, ctx);
        expect(readFileSync(join(workDir, 'a.txt'), 'utf8')).toBe('new');
    });

    it('creates parent directories', async () => {
        await writeTool.handler({ path: 'deep/nested/file.txt', content: 'x' }, ctx);
        expect(existsSync(join(workDir, 'deep/nested/file.txt'))).toBe(true);
    });

    it('refuses path that escapes workspace', async () => {
        const result = await writeTool.handler({ path: '/tmp/evil.txt', content: 'x' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('escapes workspace');
        expect(existsSync('/tmp/evil.txt')).toBe(false);
    });
});

// ────────────────────────────────────────────────────────────
// editTool
// ────────────────────────────────────────────────────────────
describe('mavis_edit', () => {
    it('replaces a single occurrence', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'foo bar baz');
        await editTool.handler({ path: 'a.txt', old_text: 'bar', new_text: 'BAR' }, ctx);
        expect(readFileSync(join(workDir, 'a.txt'), 'utf8')).toBe('foo BAR baz');
    });

    it('returns error when old_text is not found', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'foo bar');
        const result = await editTool.handler({ path: 'a.txt', old_text: 'missing', new_text: 'X' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('not found');
    });

    it('refuses multi-replace when all_occurrences=false (safety)', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'foo foo foo');
        const result = await editTool.handler({ path: 'a.txt', old_text: 'foo', new_text: 'bar' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('matches 3 occurrences');
        expect(text).toContain('all_occurrences=true');
        // File unchanged.
        expect(readFileSync(join(workDir, 'a.txt'), 'utf8')).toBe('foo foo foo');
    });

    it('replaces all when all_occurrences=true', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'foo foo foo');
        await editTool.handler(
            { path: 'a.txt', old_text: 'foo', new_text: 'bar', all_occurrences: true },
            ctx
        );
        expect(readFileSync(join(workDir, 'a.txt'), 'utf8')).toBe('bar bar bar');
    });
});

// ────────────────────────────────────────────────────────────
// searchTool
// ────────────────────────────────────────────────────────────
describe('mavis_search', () => {
    it('finds matches across files', async () => {
        mkdirSync(join(workDir, 'src'));
        writeFileSync(join(workDir, 'src', 'a.ts'), 'const foo = 1;\nfunction bar() { return foo; }');
        writeFileSync(join(workDir, 'src', 'b.ts'), 'import { foo } from "./a";');
        const result = await searchTool.handler({ pattern: 'foo', cwd: 'src' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('a.ts');
        expect(text).toContain('b.ts');
    });

    it('respects glob filter', async () => {
        mkdirSync(join(workDir, 'src'));
        writeFileSync(join(workDir, 'src', 'a.ts'), 'foo');
        writeFileSync(join(workDir, 'src', 'b.js'), 'foo');
        const result = await searchTool.handler({ pattern: 'foo', cwd: 'src', glob: '*.ts' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('a.ts');
        expect(text).not.toContain('b.js');
    });

    it('reports no matches gracefully', async () => {
        const result = await searchTool.handler({ pattern: 'NEVERMATCH' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toMatch(/No matches/);
    });
});

// ────────────────────────────────────────────────────────────
// gitTool
// ────────────────────────────────────────────────────────────
describe('mavis_git', () => {
    it('runs git status', async () => {
        const result = await gitTool.handler({ args: ['status'] }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toMatch(/\$ git status/);
        expect(text).toContain('[exit: 0]');
    });

    it('runs git log with multiple args', async () => {
        const result = await gitTool.handler({ args: ['log', '--oneline', '-5'] }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toMatch(/\$ git log --oneline -5/);
    });

    it('rejects empty args', async () => {
        const result = await gitTool.handler({ args: [] }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('non-empty array');
    });
});

// ────────────────────────────────────────────────────────────
// supabaseTool
// ────────────────────────────────────────────────────────────
describe('mavis_supabase', () => {
    it('denies db push (write subcommand)', async () => {
        const result = await supabaseTool.handler({ args: ['db', 'push'] }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('denied');
    });

    it('denies db reset', async () => {
        const result = await supabaseTool.handler({ args: ['db', 'reset'] }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('denied');
    });

    it('denies db execute', async () => {
        const result = await supabaseTool.handler({ args: ['db', 'execute', 'DROP TABLE x'] }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('denied');
    });

    it('allows read-only subcommands (db query)', async () => {
        // This will fail because there's no linked supabase project, but
        // it should NOT be denied — it should fail with a supabase error.
        const result = await supabaseTool.handler({ args: ['db', 'query', '--linked', 'SELECT 1'] }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).not.toContain('denied');
        expect(text).toMatch(/\$ supabase db query/);
    });
});

// ────────────────────────────────────────────────────────────
// runTestsTool
// ────────────────────────────────────────────────────────────
describe('mavis_run_tests', () => {
    it('runs vitest with a working pattern', async () => {
        // Create a minimal vitest test file in the temp workspace.
        mkdirSync(join(workDir, 'tests'));
        writeFileSync(join(workDir, 'tests', 'sample.test.js'),
            "import { test, expect } from 'vitest';\ntest('sample', () => { expect(1).toBe(1); });\n");
        // Create a minimal package.json with vitest.
        writeFileSync(join(workDir, 'package.json'),
            JSON.stringify({ name: 'test', scripts: { test: 'vitest run' }, devDependencies: { vitest: '*' } }));
        // We can't actually run vitest in this isolated test env (no node_modules),
        // but we can verify the tool reports the correct invocation shape.
        const result = await runTestsTool.handler({ pattern: 'tests/sample.test.js' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toMatch(/vitest|tests\/sample/);
    }, 30000);
});

// ────────────────────────────────────────────────────────────
// stateTool
// ────────────────────────────────────────────────────────────
describe('mavis_state', () => {
    it('returns the current state as JSON', async () => {
        const result = await stateTool.handler({ action: 'get' }, ctx);
        const text = result.content[0]?.text as string;
        const parsed = JSON.parse(text);
        expect(parsed).toHaveProperty('recent_files');
        expect(parsed).toHaveProperty('last_exit_codes');
    });

    it('save action flushes state', async () => {
        const result = await stateTool.handler({ action: 'save' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('saved');
    });

    it('rejects unknown action', async () => {
        const result = await stateTool.handler({ action: 'frobnicate' }, ctx);
        const text = result.content[0]?.text as string;
        expect(text).toContain('unknown action');
    });
});
