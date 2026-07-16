/**
 * Tool: mavis_run_tests
 * Run vitest with optional pattern.
 *
 * Inputs:
 *   - pattern (string, optional): vitest pattern, e.g. "qc_5_7" or "tests/wire/"
 *   - cwd (string, optional): subdirectory
 *   - bail (bool, optional): stop on first failure
 *   - timeout_ms (number, optional): default 120000 (2 min)
 *
 * Returns: vitest stdout/stderr/exit.
 *
 * Auto-detects: npx vitest, pnpm vitest, node_modules/.bin/vitest.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from './types.js';

const execFileAsync = promisify(execFile);

export const runTestsTool: ToolDef = {
    name: 'mavis_run_tests',
    description:
        'Run vitest tests in the workspace. ' +
        'Optional pattern to filter (e.g. file name or directory). ' +
        'Returns the full vitest output (truncated at 5MB). ' +
        'Use this to verify a fix worked or to reproduce a failure.',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Vitest pattern. E.g. "qc_5_7" or "tests/wire/sprint28/".'
            },
            cwd: {
                type: 'string',
                description: 'Subdirectory relative to workspace root.'
            },
            bail: {
                type: 'boolean',
                description: 'Stop on first failure. Default false.'
            },
            timeout_ms: {
                type: 'number',
                description: 'Test timeout in ms. Default 120000 (2 min).'
            }
        },
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);
        const pattern = args.pattern as string | undefined;
        const bail = (args.bail as boolean | undefined) ?? false;
        const timeout = (args.timeout_ms as number | undefined) ?? 120000;

        // Detect runner.
        const vitestBin = join(cwd, 'node_modules/.bin/vitest');
        const useBin = existsSync(vitestBin);
        const cmd = useBin ? vitestBin : 'npx';
        const cmdArgs = useBin
            ? ['run', '--reporter=default', bail ? '--bail=1' : '--no-bail', ...(pattern ? [pattern] : [])]
            : ['vitest', 'run', '--reporter=default', bail ? '--bail=1' : '--no-bail', ...(pattern ? [pattern] : [])];

        try {
            const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
                cwd,
                timeout,
                maxBuffer: 5 * 1024 * 1024,
                env: { ...process.env, FORCE_COLOR: '0', CI: 'true' }
            });
            ctx.state.recordExitCode(0);
            return textResult(formatOutput(cmd, cmdArgs, cwd, 0, stdout, stderr));
        } catch (err: any) {
            const stdout = err.stdout || '';
            const stderr = err.stderr || '';
            const code = typeof err.code === 'number' ? err.code : 1;
            ctx.state.recordExitCode(code);
            const timedOut = err.killed && err.signal === 'SIGTERM';
            const note = timedOut ? `\n[killed: timeout ${timeout}ms exceeded]` : '';
            return textResult(formatOutput(cmd, cmdArgs, cwd, code, stdout, stderr) + note);
        }
    }
};

function formatOutput(cmd: string, args: string[], cwd: string, code: number, stdout: string, stderr: string): string {
    const head = `$ ${cmd} ${args.join(' ')}\n[cwd: ${cwd}]\n[exit: ${code}]\n`;
    const out = stdout ? `--stdout--\n${stdout}` : '';
    const err = stderr ? `--stderr--\n${stderr}` : '';
    return [head, out, err].filter(Boolean).join('\n');
}

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
