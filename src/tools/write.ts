/**
 * Tool: mavis_write
 * Write/overwrite a file in the workspace.
 *
 * Inputs:
 *   - path (string, required): path relative to workspace root
 *   - content (string, required): the full file content
 *   - cwd (string, optional): subdirectory to resolve path against
 *
 * Returns: confirmation with bytes written.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ToolDef } from './types.js';

export const writeTool: ToolDef = {
    name: 'mavis_write',
    description:
        'Write content to a file, overwriting any existing content. ' +
        'Creates parent directories as needed. ' +
        'Use this for new files or full rewrites. For targeted edits, use mavis_edit instead.',
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path relative to workspace root (or absolute within workspace).'
            },
            content: {
                type: 'string',
                description: 'The full file content to write.'
            },
            cwd: {
                type: 'string',
                description: 'Subdirectory to resolve path against.'
            }
        },
        required: ['path', 'content'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);
        const requested = args.path as string;
        const content = args.content as string;
        const abs = isAbsolute(requested) ? requested : resolve(cwd, requested);
        if (!ctx.workspace.contains(abs)) {
            return textResult(`Error: path escapes workspace: ${requested}`);
        }

        const dir = dirname(abs);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(abs, content, 'utf8');
        ctx.state.recordFile(abs);
        return textResult(`Wrote ${content.length} bytes to ${requested}`);
    }
};

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
