/**
 * Mavis Noter — wraps the nlm CLI for NotebookLM interactions.
 *
 * Sprint B-4. Lets the LLM (and Claude Code) query and update the
 * KOMO OS NotebookLM notebook, which is the "manifiesto doctrinal
 * vivo" of the project. 50+ sources with architecture decisions,
 * doctrines, and historical learning.
 *
 * Why wrap nlm CLI instead of calling NotebookLM API directly:
 *   - nlm is already authenticated (cookies + CSRF token) and tested
 *   - It handles conversation-id persistence
 *   - It manages the headless browser auth flow
 *   - One less dep, one less auth flow to maintain
 *
 * Actions supported in v1:
 *   - query         : ask the notebook a question (with optional conversation-id)
 *   - add_source    : add a file or URL to a notebook
 *   - create_notebook: create a new notebook
 *   - list_notebooks: list existing notebooks
 *   - doctor        : check nlm installation / auth status
 *
 * Design notes:
 *   - Pure function: takes (request, execFn) and returns Promise<AgentResult<NoterResponse>>.
 *     The execFn is injectable for tests; the tool wrapper provides the
 *     real child_process.execFile binding.
 *   - PATH augmentation: nlm is installed at $HOME/Library/Python/3.13/bin
 *     on macOS. We augment the child env so `nlm` resolves without the
 *     user having to export PATH.
 *   - Read-only by default: query and list_notebooks don't change state.
 *     add_source and create_notebook are explicit mutations.
 *   - Latency via hrtime.bigint() (monotonic).
 */

import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type {
    AgentResult,
    NoterRequest,
    NoterResponse
} from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_SECONDS = 60;

/**
 * Build the environment for nlm child process. Augments PATH so
 * `nlm` resolves even when the user hasn't exported it.
 */
function buildNlmEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // nlm typically lives in a Python bin dir that may not be on PATH
    // when the MCP server is launched by Claude Code (no shell init).
    const candidates = [
        `${homedir()}/Library/Python/3.13/bin`,
        `${homedir()}/.local/bin`,
        '/usr/local/bin',
        '/opt/homebrew/bin'
    ];
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const existing = env.PATH || '';
    env.PATH = `${candidates.join(pathSep)}${pathSep}${existing}`;
    return env;
}

/**
 * Signature of the exec function. Lets us inject a mock for tests.
 * Note: child_process.execFile's stdout/stderr can be string or Buffer;
 * we coerce to string at the call site.
 */
export type NlmExec = (
    args: string[],
    opts: ExecFileOptions
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Parse nlm's notebook list output. The CLI's actual output is a JSON
 * array (as of notebooklm-mcp-cli 0.6.x) like:
 *   [{ "id": "uuid", "title": "Name", "source_count": N, "updated_at": "..." }]
 * Older versions used `id: UUID  title: Name` lines. We try JSON first,
 * then fall back to a regex over the lines.
 */
function parseNotebookList(stdout: string): Array<{ id: string; title: string }> {
    // Try JSON first.
    const trimmed = stdout.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            return arr
                .filter((n: any) => n && typeof n.id === 'string')
                .map((n: any) => ({
                    id: n.id,
                    title: typeof n.title === 'string' ? n.title : ''
                }));
        } catch {
            // Not valid JSON, fall through to regex.
        }
    }
    // Fallback: regex over "id: UUID  title: Name" lines.
    const lines = stdout.split('\n');
    const notebooks: Array<{ id: string; title: string }> = [];
    for (const line of lines) {
        const m = line.match(/id:\s*([0-9a-f-]{36})\s+title:\s*(.+)/i);
        if (m) {
            notebooks.push({ id: m[1], title: m[2].trim() });
        }
    }
    return notebooks;
}

/**
 * Extract the notebook ID from nlm's create_notebook output. Falls back
 * to regex over the full stdout.
 */
function extractNotebookId(stdout: string): string | undefined {
    const m = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m?.[0];
}

/**
 * Validate the request. Returns an error result if invalid.
 */
function validateRequest(req: NoterRequest): AgentResult<never> | null {
    if (!req || !req.action) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: 'noter: action is required (query | add_source | create_notebook | list_notebooks | doctor).'
            }
        };
    }
    if (req.action === 'query') {
        if (!req.notebook_id) {
            return {
                ok: false,
                error: {
                    kind: 'invalid_request',
                    message: 'noter query: notebook_id is required.'
                }
            };
        }
        if (!req.question || req.question.trim() === '') {
            return {
                ok: false,
                error: {
                    kind: 'invalid_request',
                    message: 'noter query: question is required and must be a non-empty string.'
                }
            };
        }
    }
    if (req.action === 'add_source' && (!req.notebook_id || !req.source)) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: 'noter add_source: notebook_id and source are required.'
            }
        };
    }
    if (req.action === 'create_notebook' && !req.title) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: 'noter create_notebook: title is required.'
            }
        };
    }
    return null;
}

/**
 * Run a nlm CLI command. Pure function: takes the request and an
 * injectable exec function, returns AgentResult.
 */
export async function runNoter(
    req: NoterRequest,
    exec: NlmExec = async (args, opts) => {
        const result = await execFileAsync('nlm', args, opts);
        return {
            stdout: typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8'),
            stderr: typeof result.stderr === 'string' ? result.stderr : result.stderr.toString('utf8')
        };
    }
): Promise<AgentResult<NoterResponse>> {
    const validationError = validateRequest(req);
    if (validationError) return validationError;

    const timeout = (req.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    const env = buildNlmEnv();

    const tStart = process.hrtime.bigint();

    try {
        let stdout: string;
        let actionResult: Partial<NoterResponse> = {};

        switch (req.action) {
            case 'doctor': {
                const { stdout: out } = await exec(['doctor'], { env, timeout });
                stdout = out;
                actionResult = {
                    answer: out.trim() || 'nlm doctor: OK',
                    raw_stdout: out
                };
                break;
            }
            case 'list_notebooks': {
                const { stdout: out } = await exec(['notebook', 'list'], { env, timeout });
                stdout = out;
                actionResult = {
                    notebooks: parseNotebookList(out),
                    raw_stdout: out
                };
                break;
            }
            case 'create_notebook': {
                const { stdout: out } = await exec(
                    ['notebook', 'create', req.title!],
                    { env, timeout }
                );
                stdout = out;
                const newId = extractNotebookId(out);
                actionResult = {
                    notebook_id: newId,
                    answer: newId ? `Created notebook: ${newId}` : out.trim(),
                    raw_stdout: out
                };
                break;
            }
            case 'add_source': {
                const { stdout: out } = await exec(
                    ['source', 'add', req.notebook_id!, req.source!],
                    { env, timeout }
                );
                stdout = out;
                actionResult = {
                    answer: out.trim() || `Added source: ${req.source}`,
                    raw_stdout: out
                };
                break;
            }
            case 'query': {
                const queryArgs = ['notebook', 'query', req.notebook_id!, req.question!];
                if (req.conversation_id) {
                    queryArgs.push('--conversation-id', req.conversation_id);
                }
                const { stdout: out } = await exec(queryArgs, { env, timeout });
                stdout = out;
                // nlm query output is plain text (the model's answer).
                // Conversation id is echoed back if it was used; for v1
                // we just return what the user provided (nlm persists it
                // server-side).
                actionResult = {
                    answer: out.trim(),
                    conversation_id: req.conversation_id,
                    raw_stdout: out
                };
                break;
            }
            default: {
                // Should be caught by validateRequest, but defense in depth.
                return {
                    ok: false,
                    error: {
                        kind: 'invalid_request',
                        message: `noter: unknown action "${(req as any).action}".`
                    }
                };
            }
        }

        const tEnd = process.hrtime.bigint();
        const latency_ms = Number(tEnd - tStart) / 1_000_000;

        return {
            ok: true,
            data: {
                ...actionResult,
                latency_ms: Math.round(latency_ms * 100) / 100
            }
        };
    } catch (err: any) {
        const tEnd = process.hrtime.bigint();
        const latency_ms = Number(tEnd - tStart) / 1_000_000;

        // execFile error: err.code (ENOENT = nlm not found), err.stderr, err.message
        const code = err?.code;
        const message = err?.message || String(err);
        const stderr = err?.stderr || '';

        let kind = 'api_error';
        if (code === 'ENOENT') kind = 'config_error'; // nlm not on PATH
        else if (code === 'ETIMEDOUT' || err?.killed) kind = 'timeout';
        else if (/auth|unauthorized|login|cookie/i.test(stderr + message)) kind = 'auth_error';

        return {
            ok: false,
            error: {
                kind,
                message: `noter: ${message}`,
                details: {
                    code,
                    stderr: stderr.slice(0, 500),
                    latency_ms: Math.round(latency_ms * 100) / 100
                }
            }
        };
    }
}
