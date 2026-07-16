/**
 * Tool: mavis_supabase
 * Supabase CLI queries (read-only by default).
 *
 * Inputs:
 *   - args (array of strings, required): supabase args
 *   - cwd (string, optional): subdirectory
 *
 * Returns: supabase stdout/stderr/exit.
 *
 * Note: Supabase CLI is read-only by default. The `db push` subcommand
 * is dangerous and NOT whitelisted here. The MCP server assumes the
 * workspace has a valid `supabase` CLI install + linked project.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef } from './types.js';

const execFileAsync = promisify(execFile);

// Subcommands that MUTATE the database. Explicitly denied.
// We allow read-only commands like `db query`, `db diff`, `db remote commit`.
const DENY_SUBCOMMANDS = [
    'db push',         // apply migrations to remote
    'db reset',        // drop + recreate local DB
    'db execute',      // arbitrary SQL on remote (too dangerous)
    'migration up'     // apply migrations locally
];

export const supabaseTool: ToolDef = {
    name: 'mavis_supabase',
    description:
        'Run a supabase CLI command in the workspace. ' +
        'Read-only by design — write subcommands (db push, db reset, db execute) are denied. ' +
        'Examples: ["db", "query", "--linked", "SELECT 1"], ["db", "diff"], ["db", "remote", "commit"].',
    inputSchema: {
        type: 'object',
        properties: {
            args: {
                type: 'array',
                items: { type: 'string' },
                description: 'Supabase CLI args. E.g. ["db", "query", "--linked", "SELECT 1"].'
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
        const sbArgs = args.args as string[];
        if (!Array.isArray(sbArgs) || sbArgs.length === 0) {
            return textResult('Error: args must be a non-empty array of strings.');
        }

        // Denylist check: deny dangerous subcommands.
        const subcommand = sbArgs.slice(0, 2).join(' ');
        for (const denied of DENY_SUBCOMMANDS) {
            if (subcommand === denied || subcommand.startsWith(denied + ' ')) {
                return textResult(
                    `Error: supabase subcommand "${denied}" is denied for safety.\n` +
                    `This MCP server only exposes read-only supabase commands. ` +
                    `Use the supabase CLI directly for migrations.`
                );
            }
        }

        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);

        try {
            const { stdout, stderr } = await execFileAsync('supabase', sbArgs, {
                cwd,
                timeout: 30000,
                maxBuffer: 10 * 1024 * 1024,
                env: { ...process.env, SUPABASE_LOG_LEVEL: 'warn' }
            });
            ctx.state.recordExitCode(0);
            return textResult(formatOutput(sbArgs, cwd, 0, stdout, stderr));
        } catch (err: any) {
            const stdout = err.stdout || '';
            const stderr = err.stderr || '';
            const code = typeof err.code === 'number' ? err.code : 1;
            ctx.state.recordExitCode(code);
            return textResult(formatOutput(sbArgs, cwd, code, stdout, stderr));
        }
    }
};

function formatOutput(args: string[], cwd: string, code: number, stdout: string, stderr: string): string {
    const head = `$ supabase ${args.join(' ')}\n[cwd: ${cwd}]\n[exit: ${code}]\n`;
    const out = stdout ? `--stdout--\n${stdout}` : '';
    const err = stderr ? `--stderr--\n${stderr}` : '';
    return [head, out, err].filter(Boolean).join('\n');
}

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
