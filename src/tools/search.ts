/**
 * Tool: mavis_search
 * Search for a regex pattern across files in the workspace.
 *
 * Inputs:
 *   - pattern (string, required): regex pattern
 *   - glob (string, optional): file glob filter, e.g. dot-ts files or "src/anydepth js files". Default: all.
 *   - cwd (string, optional): subdirectory to search in
 *   - max_results (number, optional): cap results (default 100)
 *   - case_insensitive (bool, optional): default false
 *
 * Returns: list of file:line: matches.
 *
 * Uses ripgrep if available, else falls back to a simple recursive grep.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef } from './types.js';

const execFileAsync = promisify(execFile);

export const searchTool: ToolDef = {
    name: 'mavis_search',
    description:
        'Search for a regex pattern across files in the workspace. ' +
        'Returns file:line:match lines. ' +
        'Uses ripgrep if available (fast), else falls back to node recursive search.',
    inputSchema: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'Regex pattern to search for. E.g. "TODO|FIXME" or "function\\s+foo".'
            },
            glob: {
                type: 'string',
                description: 'File glob filter. E.g. "*.ts" or "src/**/*.js". Default: *.'
            },
            cwd: {
                type: 'string',
                description: 'Subdirectory to search in. Default: workspace root.'
            },
            max_results: {
                type: 'number',
                description: 'Cap results. Default 100.'
            },
            case_insensitive: {
                type: 'boolean',
                description: 'Case-insensitive search. Default false.'
            }
        },
        required: ['pattern'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);
        const pattern = args.pattern as string;
        const glob = (args.glob as string | undefined) ?? '*';
        const max = (args.max_results as number | undefined) ?? 100;
        const ci = (args.case_insensitive as boolean | undefined) ?? false;

        // Try ripgrep first.
        try {
            const rgArgs = [
                '--line-number',
                '--no-heading',
                '--max-count', String(max),
                ci ? '--ignore-case' : '--no-ignore-case',
                '--glob', glob,
                '--', pattern
            ];
            const { stdout } = await execFileAsync('rg', rgArgs, {
                cwd,
                timeout: 15000,
                maxBuffer: 5 * 1024 * 1024
            });
            return textResult(formatResults('rg', pattern, cwd, glob, stdout, max));
        } catch (err: any) {
            // rg not found (ENOENT) or no matches (exit 1) or error.
            // If ENOENT, fall through to node search.
            if (err.code !== 'ENOENT') {
                // rg found nothing (exit 1) or had an error; report.
                const stdout = err.stdout || '';
                const code = err.code;
                // Exit 1 = no matches, that's fine.
                if (code === 1) {
                    return textResult(`No matches for /${pattern}/ in ${cwd} (glob: ${glob}).`);
                }
                return textResult(`rg error: ${err.message || err}\n${stdout}`);
            }
            // ENOENT: rg not installed. Fall through to node.
        }

        // Fallback: simple recursive search using node.
        try {
            const { readFileSync } = await import('node:fs');
            const { join } = await import('node:path');
            const re = new RegExp(pattern, ci ? 'i' : '');
            // Use a simple glob match: split pattern, check extension.
            const files = collectFiles(cwd, glob, max);
            const out: string[] = [];
            for (const f of files) {
                if (out.length >= max) break;
                try {
                    const text = readFileSync(f, 'utf8');
                    const lines = text.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (re.test(lines[i])) {
                            out.push(`${f}:${i + 1}:${lines[i]}`);
                            if (out.length >= max) break;
                        }
                    }
                } catch {
                    // skip unreadable
                }
            }
            return textResult(formatResults('node', pattern, cwd, glob, out.join('\n'), max));
        } catch (err: any) {
            return textResult(`search error: ${err.message || err}`);
        }
    }
};

function formatResults(
    backend: string, pattern: string, cwd: string, glob: string, stdout: string, max: number
): string {
    if (!stdout.trim()) {
        return `No matches for /${pattern}/ in ${cwd} (glob: ${glob}).`;
    }
    const lines = stdout.split('\n');
    const truncated = lines.length > max ? `\n[truncated to first ${max} of ${lines.length} matches]` : '';
    return `[backend: ${backend}]\n[pattern: /${pattern}/]\n[cwd: ${cwd}]\n[glob: ${glob}]\n\n${lines.slice(0, max).join('\n')}${truncated}`;
}

function collectFiles(root: string, glob: string, max: number): string[] {
    // Very simple glob: support * and ** for extension/path matching.
    // For patterns like "*.ts" we filter by extension. For "src/**/*.js" we
    // recurse. This is intentionally simple — for complex globs, use rg.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const { join: pathJoin } = require('node:path') as typeof import('node:path');
    const { readdirSync, statSync } = fs;
    const join = pathJoin;
    const out: string[] = [];

    function walk(dir: string, rel: string) {
        if (out.length >= max) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch { return; }
        for (const e of entries) {
            if (out.length >= max) return;
            const abs = join(dir, e);
            const childRel = rel ? `${rel}/${e}` : e;
            let stat;
            try { stat = statSync(abs); } catch { continue; }
            if (stat.isDirectory()) {
                // Skip common heavy dirs.
                if (['node_modules', '.git', 'dist', '.mavis', 'coverage'].includes(e)) continue;
                walk(abs, childRel);
            } else {
                if (matchesGlob(childRel, glob)) out.push(abs);
            }
        }
    }

    walk(root, '');
    return out;
}

function matchesGlob(path: string, glob: string): boolean {
    // Convert glob to regex.
    // * -> [^/]*
    // ** -> .*
    // . -> \.
    const re = glob
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '::DOUBLESTAR::')
        .replace(/\*/g, '[^/]*')
        .replace(/::DOUBLESTAR::/g, '.*');
    return new RegExp(`^${re}$`).test(path);
}

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
