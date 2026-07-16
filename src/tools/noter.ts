/**
 * mavis_noter tool — wraps the nlm CLI for NotebookLM.
 *
 * Sprint B-4. Lets Claude Code query the KOMO OS NotebookLM notebook
 * (or any notebook) for doctrinal alignment, historical decisions,
 * and antipattern documentation.
 *
 * Input:
 *   action            (string, required) — query | add_source | create_notebook | list_notebooks | doctor
 *   notebook_id       (string, optional, required for query/add_source) — UUID
 *   question          (string, optional, required for query)
 *   source            (string, optional, required for add_source) — file path or URL
 *   title             (string, optional, required for create_notebook)
 *   conversation_id   (string, optional) — keeps context across queries
 *   timeout_seconds   (int, optional — default 60)
 *
 * Output:
 *   { ok: true, data: { answer?, notebooks?, notebook_id?, conversation_id?,
 *                        raw_stdout?, latency_ms } }
 *
 * Default notebook for KOMO OS: 21102950-4bfc-4e4d-a78d-8e1a2b338d99
 * Default conversation: 48cc26af-9f4d-4776-a6eb-b1bcb35d9179
 *
 * Requires the nlm CLI on PATH. The agent layer auto-augments PATH
 * with $HOME/Library/Python/3.13/bin (and other common locations) so
 * you don't need to export PATH yourself.
 *
 * Authentication: nlm uses pre-saved Google cookies (managed by
 * nlm login). Run `nlm login` once before using this tool.
 */

import { runNoter } from '../agents/noter.js';
import type { NoterAction, NoterRequest } from '../agents/types.js';
import type { ToolDef } from './types.js';

const VALID_ACTIONS: NoterAction[] = ['query', 'add_source', 'create_notebook', 'list_notebooks', 'doctor'];

/** Default KOMO OS notebook (per docs/MCP_GUIDE.md). */
export const DEFAULT_KOMO_NOTEBOOK = '21102950-4bfc-4e4d-a78d-8e1a2b338d99';
export const DEFAULT_KOMO_CONVERSATION = '48cc26af-9f4d-4776-a6eb-b1bcb35d9179';

export const noterTool: ToolDef = {
    name: 'mavis_noter',
    description:
        'Query and update the KOMO OS NotebookLM notebook via the nlm CLI. ' +
        'Use to check doctrinal alignment, look up historical decisions, and ' +
        'document new patterns. Default notebook is the KOMO OS doctrinal ' +
        'manifiesto (50+ sources). Actions: query, add_source, create_notebook, ' +
        'list_notebooks, doctor. Requires nlm CLI installed and authenticated.',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: VALID_ACTIONS as string[],
                description: 'What to do. Default notebook: ' + DEFAULT_KOMO_NOTEBOOK
            },
            notebook_id: {
                type: 'string',
                description: 'Notebook UUID. Defaults to the KOMO OS doctrinal notebook if omitted (for query/add_source).'
            },
            question: {
                type: 'string',
                description: 'The question to ask the notebook (required for action=query).'
            },
            source: {
                type: 'string',
                description: 'File path or URL to add as a source (required for action=add_source).'
            },
            title: {
                type: 'string',
                description: 'Notebook title (required for action=create_notebook).'
            },
            conversation_id: {
                type: 'string',
                description: 'Conversation UUID for context persistence. Default: ' + DEFAULT_KOMO_CONVERSATION
            },
            timeout_seconds: {
                type: 'integer',
                minimum: 5,
                maximum: 600,
                description: 'Max wait for nlm CLI. Default 60.'
            }
        },
        required: ['action'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        // Validate action.
        const action = String(args.action ?? '');
        if (!VALID_ACTIONS.includes(action as NoterAction)) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ok: false,
                        error: {
                            kind: 'invalid_request',
                            message: `mavis_noter: action must be one of ${VALID_ACTIONS.join(', ')}. Got: ${action}`
                        }
                    }, null, 2)
                }],
                isError: true
            };
        }

        // Default notebook_id for query/add_source.
        const notebookId = args.notebook_id !== undefined
            ? String(args.notebook_id)
            : (action === 'query' || action === 'add_source' ? DEFAULT_KOMO_NOTEBOOK : undefined);

        const req: NoterRequest = {
            action: action as NoterAction,
            notebook_id: notebookId,
            question: args.question !== undefined ? String(args.question) : undefined,
            source: args.source !== undefined ? String(args.source) : undefined,
            title: args.title !== undefined ? String(args.title) : undefined,
            conversation_id: args.conversation_id !== undefined ? String(args.conversation_id) : DEFAULT_KOMO_CONVERSATION,
            timeout_seconds: args.timeout_seconds !== undefined ? Number(args.timeout_seconds) : undefined
        };

        const result = await runNoter(req);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }],
            isError: !result.ok
        };
    }
};
