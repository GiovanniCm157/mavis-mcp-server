/**
 * mavis_session_log tool — read/persist agent run traces.
 *
 * Sprint B-5. Provides programmatic access to the JSONL files written
 * by mavis_coder_agent to ~/.mavis-mcp/agent-sessions/.
 *
 * Use cases:
 *   - "Show me my last 5 agent runs" (action=list)
 *   - "Get the full trace of session X" (action=get)
 *   - "What happened in the last 3 iterations of X?" (action=tail)
 *   - "Clean up sessions older than 7 days" (action=clear)
 *
 * Input:
 *   action     (string, required) — list | get | tail | clear
 *   session_id (string, optional, required for get/tail) — id or filename
 *   limit      (int, optional — for list, default 20)
 *   tail_n     (int, optional — for tail, default 5)
 *   max_age_days (int, optional — for clear, default 30)
 *
 * Output: JSON with the requested data.
 */

import {
    listSessions,
    readSessionEvents,
    tailSessionEvents,
    clearOldSessions,
    defaultSessionLogDir
} from '../agents/session-log.js';
import type { ToolDef } from './types.js';

const VALID_ACTIONS = ['list', 'get', 'tail', 'clear'] as const;
type SessionLogAction = typeof VALID_ACTIONS[number];

export const sessionLogTool: ToolDef = {
    name: 'mavis_session_log',
    description:
        'Read agent run traces persisted to ~/.mavis-mcp/agent-sessions/. ' +
        'Actions: list (recent sessions), get (full session by id/file), ' +
        'tail (last N events of a session), clear (delete sessions older than N days). ' +
        'Use to debug, audit, or post-mortem past mavis_coder_agent runs.',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: VALID_ACTIONS as unknown as string[],
                description: 'What to do with the session log.'
            },
            session_id: {
                type: 'string',
                description: 'Session id (UUID) or filename. Required for get and tail.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 200,
                description: 'For action=list: max sessions to return. Default 20.'
            },
            tail_n: {
                type: 'integer',
                minimum: 1,
                maximum: 200,
                description: 'For action=tail: how many most recent events to return. Default 5.'
            },
            max_age_days: {
                type: 'integer',
                minimum: 1,
                maximum: 3650,
                description: 'For action=clear: delete sessions older than this. Default 30.'
            }
        },
        required: ['action'],
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        const action = String(args.action ?? '');
        if (!VALID_ACTIONS.includes(action as SessionLogAction)) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ok: false,
                        error: {
                            kind: 'invalid_request',
                            message: `mavis_session_log: action must be one of ${VALID_ACTIONS.join(', ')}. Got: ${action}`
                        }
                    }, null, 2)
                }],
                isError: true
            };
        }

        // Use ctx.workspace.parent or MAVIS_SESSION_LOG_DIR. We use the
        // session-log module's default which honors the env var, so we
        // don't need to pass dir explicitly.
        try {
            switch (action as SessionLogAction) {
                case 'list': {
                    const limit = args.limit !== undefined ? Number(args.limit) : 20;
                    const sessions = listSessions(undefined, limit);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                ok: true,
                                data: {
                                    log_dir: defaultSessionLogDir(),
                                    count: sessions.length,
                                    sessions
                                }
                            }, null, 2)
                        }]
                    };
                }
                case 'get': {
                    const sessionId = args.session_id;
                    if (!sessionId) {
                        return errResult('invalid_request', 'mavis_session_log get: session_id is required.');
                    }
                    // Try to find the file by session_id (search list) first;
                    // fall back to treating session_id as a filename.
                    const summaries = listSessions(undefined, 200);
                    const match = summaries.find(s => s.session_id === sessionId);
                    const file = match?.file || sessionId;
                    const events = readSessionEvents(file);
                    if (events.length === 0) {
                        return errResult('not_found', `No session found for id "${sessionId}". Check the id or pass a filename.`);
                    }
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                ok: true,
                                data: {
                                    session_id: match?.session_id || sessionId,
                                    file,
                                    event_count: events.length,
                                    events
                                }
                            }, null, 2)
                        }]
                    };
                }
                case 'tail': {
                    const sessionId = args.session_id;
                    if (!sessionId) {
                        return errResult('invalid_request', 'mavis_session_log tail: session_id is required.');
                    }
                    const tailN = args.tail_n !== undefined ? Number(args.tail_n) : 5;
                    const summaries = listSessions(undefined, 200);
                    const match = summaries.find(s => s.session_id === sessionId);
                    const file = match?.file || sessionId;
                    const events = tailSessionEvents(file, tailN);
                    if (events.length === 0) {
                        return errResult('not_found', `No session found for id "${sessionId}".`);
                    }
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                ok: true,
                                data: {
                                    session_id: match?.session_id || sessionId,
                                    file,
                                    event_count: events.length,
                                    events
                                }
                            }, null, 2)
                        }]
                    };
                }
                case 'clear': {
                    const maxAge = args.max_age_days !== undefined ? Number(args.max_age_days) : 30;
                    const deleted = clearOldSessions(maxAge);
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                ok: true,
                                data: {
                                    deleted,
                                    max_age_days: maxAge,
                                    log_dir: defaultSessionLogDir()
                                }
                            }, null, 2)
                        }]
                    };
                }
            }
        } catch (err: any) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ok: false,
                        error: {
                            kind: 'api_error',
                            message: `mavis_session_log ${action}: ${err?.message || String(err)}`
                        }
                    }, null, 2)
                }],
                isError: true
            };
        }
    }
};

function errResult(kind: string, message: string) {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: { kind, message } }, null, 2)
        }],
        isError: true
    };
}
