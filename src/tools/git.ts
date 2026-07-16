/**
 * Tool: mavis_git
 * Git operations (read + safe write).
 *
 * Inputs:
 *   - args (array of strings, required): git args, e.g. ["status"] or ["diff", "--staged"]
 *   - cwd (string, optional): subdirectory
 *
 * Returns: git stdout/stderr/exit.
 *
 * Whitelisted subcommands for write operations (commit, push, etc.)
 * are NOT enforced here — the workspace isolation is the main safeguard.
 * If you need stricter safety, add a denylist here.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef } from './types.js';

const execFileAsync = promisify(execFile);

export const gitTool: ToolDef = {
    name: 'mavis_git',
    description:
        'Run a git command in the workspace. ' +
        'Args are passed as an array to avoid shell injection. ' +
        'Examples: ["status"], ["log", "--oneline", "-10"], ["diff"], ["add", "."], ["commit", "-m", "msg"], ["push"].',
    inputSchema: {
        type: 'object',
        properties: {
            args: {
                type: 'array',
                items: { type: 'string' },
                description: 'Git args. E.g. ["status"] or ["commit", "-m", "msg"].'
            },
            cwd: {
                type: 'string',
                description: 'Subdirectory relative to workspace root.'
            }
        },
        required: ['args'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const gitArgs = args.args as string[];
        if (!Array.isArray(gitArgs) || gitArgs.length === 0) {
            return textResult('Error: args must be a non-empty array of strings.');
        }
        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);

        try {
            const { stdout, stderr } = await execFileAsync('git', gitArgs, {
                cwd,
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }  // no interactive prompts
            });
            ctx.state.recordExitCode(0);
            return textResult(formatOutput(gitArgs, cwd, 0, stdout, stderr));
        } catch (err: any) {
            const stdout = err.stdout || '';
            const stderr = err.stderr || '';
            const code = typeof err.code === 'number' ? err.code : 1;
            ctx.state.recordExitCode(code);
            return textResult(formatOutput(gitArgs, cwd, code, stdout, stderr));
        }
    }
};

function formatOutput(args: string[], cwd: string, code: number, stdout: string, stderr: string): string {
    const head = `$ git ${args.join(' ')}\n[cwd: ${cwd}]\n[exit: ${code}]\n`;
    const out = stdout ? `--stdout--\n${stdout}` : '';
    const err = stderr ? `--stderr--\n${stderr}` : '';
    return [head, out, err].filter(Boolean).join('\n');
}

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
