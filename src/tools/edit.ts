/**
 * Tool: mavis_edit
 * Edit a file by replacing a specific string (find/replace).
 *
 * Inputs:
 *   - path (string, required): path relative to workspace root
 *   - old_text (string, required): the exact text to find
 *   - new_text (string, required): the replacement text
 *   - cwd (string, optional): subdirectory
 *   - all_occurrences (bool, optional): if true, replace ALL occurrences. Default: false (single replace).
 *
 * Returns: confirmation with number of replacements.
 *
 * Anti-pattern guard: if old_text is not found, returns an error.
 * If found multiple times and all_occurrences=false, returns an error
 * (prevents accidental multi-replace).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDef } from './types.js';

export const editTool: ToolDef = {
    name: 'mavis_edit',
    description:
        'Edit a file by replacing a specific string with new text. ' +
        'Default: replaces the FIRST occurrence only. ' +
        'If old_text is not found or matches multiple times and all_occurrences is false, returns an error. ' +
        'Use this for targeted edits; use mavis_write for full rewrites.',
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path relative to workspace root (or absolute within workspace).'
            },
            old_text: {
                type: 'string',
                description: 'The exact text to find. Must match exactly (whitespace included).'
            },
            new_text: {
                type: 'string',
                description: 'The replacement text.'
            },
            cwd: {
                type: 'string',
                description: 'Subdirectory to resolve path against.'
            },
            all_occurrences: {
                type: 'boolean',
                description: 'Replace ALL occurrences. Default: false (only first).'
            }
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const cwd = ctx.workspace.resolve(args.cwd as string | undefined);
        const requested = args.path as string;
        const oldText = args.old_text as string;
        const newText = args.new_text as string;
        const allOccurrences = (args.all_occurrences as boolean | undefined) ?? false;

        const abs = isAbsolute(requested) ? requested : resolve(cwd, requested);
        if (!ctx.workspace.contains(abs)) {
            return textResult(`Error: path escapes workspace: ${requested}`);
        }
        if (!existsSync(abs)) {
            return textResult(`Error: file not found: ${requested}`);
        }

        const original = readFileSync(abs, 'utf8');
        const occurrences = original.split(oldText).length - 1;

        if (occurrences === 0) {
            return textResult(
                `Error: old_text not found in ${requested}.\n` +
                `Tip: read the file first to see exact whitespace.`
            );
        }
        if (occurrences > 1 && !allOccurrences) {
            return textResult(
                `Error: old_text matches ${occurrences} occurrences in ${requested}.\n` +
                `Set all_occurrences=true to replace all, or make old_text more specific.`
            );
        }

        const updated = allOccurrences
            ? original.split(oldText).join(newText)
            : original.replace(oldText, newText);
        const replacements = allOccurrences ? occurrences : 1;

        writeFileSync(abs, updated, 'utf8');
        ctx.state.recordFile(abs);
        return textResult(
            `Replaced ${replacements} occurrence${replacements > 1 ? 's' : ''} in ${requested}.`
        );
    }
};

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
