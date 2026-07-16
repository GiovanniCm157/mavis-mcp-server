/**
 * Tool: mavis_bash
 * Run a shell command in the workspace.
 *
 * Inputs:
 *   - command (string, required): the shell command to run
 *   - cwd (string, optional): subdirectory relative to workspace root
 *   - timeout_ms (number, optional): kill after N ms (default 30000)
 *
 * Returns: { stdout, stderr, exit_code } as text content.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef } from './types.js';

const execFileAsync = promisify(execFile);

export const bashTool: ToolDef = {
    name: 'mavis_bash',
    description:
        'Run a shell command in the workspace. Returns stdout, stderr, and exit code. ' +
        'Use this to run any CLI: git, npm, vitest, supabase, node, etc. ' +
        'Prefer specific commands over shell scripts (no shell interpolation).',
    inputSchema: {
        type: 'object',
        properties: {
            command: {
                type: 'string',
                description: 'The shell command to run. E.g. "git status" or "npm test".'
            },
            cwd: {
                type: 'string',
                description: 'Subdirectory relative to workspace root. Defaults to root.'
            },
            timeout_ms: {
                type: 'number',
                description: 'Kill the process after N milliseconds. Default 30000 (30s).'
            }
        },
        required: ['command'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const command = args.command as string;
        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);
        const timeout = (args.timeout_ms as number | undefined) ?? 30000;

        // Use execFile with shell=true for ergonomics (cd, pipes, globs).
        // For untrusted input this would be a problem, but Claude is the only
        // caller and we trust the model.
        try {
            const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
                cwd,
                timeout,
                maxBuffer: 10 * 1024 * 1024,  // 10MB
                env: { ...process.env, FORCE_COLOR: '0' }
            });
            ctx.state.recordExitCode(0);
            return textResult(formatOutput(command, cwd, 0, stdout, stderr));
        } catch (err: any) {
            const stdout = err.stdout || '';
            const stderr = err.stderr || '';
            const code = typeof err.code === 'number' ? err.code : 1;
            ctx.state.recordExitCode(code);
            // Killed by timeout?
            const timedOut = err.killed && err.signal === 'SIGTERM';
            const note = timedOut ? `\n[killed: timeout ${timeout}ms exceeded]` : '';
            return textResult(formatOutput(command, cwd, code, stdout, stderr) + note);
        }
    }
};

function formatOutput(cmd: string, cwd: string, code: number, stdout: string, stderr: string): string {
    const head = `$ ${cmd}\n[cwd: ${cwd}]\n[exit: ${code}]\n`;
    const out = stdout ? `--stdout--\n${stdout}` : '';
    const err = stderr ? `--stderr--\n${stderr}` : '';
    return [head, out, err].filter(Boolean).join('\n');
}

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
