/**
 * Tool: mavis_state
 * Get or update persistent state.
 *
 * Inputs:
 *   - action (string, required): "get" or "save"
 *
 * "get" returns the current state (recent files, exit codes, timestamps).
 * "save" forces a flush to disk (normally automatic on tool calls).
 */

import type { ToolDef } from './types.js';

export const stateTool: ToolDef = {
    name: 'mavis_state',
    description:
        'Get or update the MCP server\'s persistent state. ' +
        'Use "get" to see recent files touched and last exit codes (useful for context). ' +
        'Use "save" to force flush state to disk.',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['get', 'save'],
                description: 'Action to perform: "get" (read state) or "save" (force flush).'
            }
        },
        required: ['action'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const action = args.action as string;
        if (action === 'save') {
            ctx.state.save();
            return textResult('State saved to disk.');
        }
        if (action === 'get') {
            const snap = ctx.state.snapshot();
            return textResult(JSON.stringify(snap, null, 2));
        }
        return textResult(`Error: unknown action "${action}". Use "get" or "save".`);
    }
};

function textResult(text: string) {
    return { content: [{ type: 'text' as const, text }] };
}
