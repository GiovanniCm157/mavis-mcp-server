/**
 * Tool: mavis_read
 * Read a file (text or image) from the workspace.
 *
 * Inputs:
 *   - path (string, required): path relative to workspace root (or absolute within workspace)
 *   - cwd (string, optional): subdirectory to resolve path against
 *   - max_lines (number, optional): truncate to N lines (returns notice if truncated)
 *
 * Returns: file content as text, or base64 + mime for images.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDef } from './types.js';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const TEXT_MAX_BYTES = 500_000; // 500KB

export const readTool: ToolDef = {
    name: 'mavis_read',
    description:
        'Read a file from the workspace. Returns text content for code/config files, ' +
        'or base64 image content for screenshots (.png, .jpg, etc.). ' +
        'Truncates very large files; use offset for partial reads.',
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path relative to workspace root (or absolute within workspace).'
            },
            cwd: {
                type: 'string',
                description: 'Subdirectory to resolve path against.'
            },
            max_lines: {
                type: 'number',
                description: 'Truncate to first N lines. Default: no limit (within TEXT_MAX_BYTES).'
            }
        },
        required: ['path'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);
        const requested = args.path as string;
        const abs = isAbsolute(requested) ? requested : resolve(cwd, requested);
        if (!ctx.workspace.contains(abs)) {
            return textResult(`Error: path escapes workspace: ${requested}`);
        }
        if (!existsSync(abs)) {
            return textResult(`Error: file not found: ${requested}`);
        }
        const stat = statSync(abs);
        if (!stat.isFile()) {
            return textResult(`Error: not a file: ${requested}`);
        }

        const ext = extname(abs).toLowerCase();
        const isImage = IMAGE_EXTS.has(ext);

        if (isImage) {
            // For images, return base64 + mime type.
            // Claude Code's image handling will display it.
            const buf = readFileSync(abs);
            const b64 = buf.toString('base64');
            const mime = mimeFromExt(ext);
            return {
                content: [
                    { type: 'image' as const, data: b64, mimeType: mime }
                ]
            };
        }

        // Text file.
        let text = readFileSync(abs, 'utf8');
        let notice = '';

        if (text.length > TEXT_MAX_BYTES) {
            text = text.slice(0, TEXT_MAX_BYTES);
            notice = `\n\n[truncated at ${TEXT_MAX_BYTES} bytes; use offset/max_lines for partial reads]`;
        }

        const maxLines = args.max_lines as number | undefined;
        if (maxLines && maxLines > 0) {
            const lines = text.split('\n');
            if (lines.length > maxLines) {
                text = lines.slice(0, maxLines).join('\n');
                notice += `\n[truncated to first ${maxLines} of ${lines.length} lines]`;
            }
        }

        ctx.state.recordFile(abs);
        return textResult(`[file: ${requested}]\n[bytes: ${stat.size}]\n\n${text}${notice}`);
    }
};

function mimeFromExt(ext: string): string {
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.bmp': return 'image/bmp';
        default: return 'application/octet-stream';
    }
}

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
