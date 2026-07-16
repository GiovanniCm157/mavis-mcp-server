/**
 * Shared types for Mavis agents.
 *
 * An "agent" is a typed wrapper around an LLM call (or call loop) that
 * adds project-specific behavior. Agents live in src/agents/ and are
 * independent of MCP — they're exposed to clients via tool wrappers
 * in src/tools/.
 *
 * Current agents:
 *   - coder         : MiniMax-M3 single-shot text generation (B-1)
 *   - coderAgent    : MiniMax-M3 with tool-calling agent loop (B-2)
 *   - auditor       : read-only KOMO antipattern detector (B-3)
 *   - noter         : wraps nlm CLI for NotebookLM queries (B-4)
 */

import type OpenAI from 'openai';

export interface CoderRequest {
    /** The user/task prompt sent to the model. */
    prompt: string;
    /** Optional system prompt that sets behavior/context. */
    system?: string;
    /** Model id. Defaults to MiniMax-M3. */
    model?: string;
    /** Max output tokens. Defaults to 4096. */
    max_tokens?: number;
    /** Sampling temperature 0-2. Defaults to 0.2 (deterministic coding). */
    temperature?: number;
}

export interface CoderUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface CoderResponse {
    content: string;
    usage: CoderUsage;
    model: string;
    latency_ms: number;
    finish_reason: string;
}

// ────────────────────────────────────────────────────────────
// B-2: Agent loop types
// ────────────────────────────────────────────────────────────

export interface AgentRequest extends CoderRequest {
    max_iterations?: number;
    tools?: string[];
    tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
}

export interface AgentToolCallRecord {
    iteration: number;
    tool_name: string;
    tool_args: Record<string, any>;
    result_summary: string;
    is_error: boolean;
    duration_ms: number;
}

export interface AgentResponse {
    final_content: string;
    iterations: number;
    tool_calls: AgentToolCallRecord[];
    total_usage: CoderUsage;
    latency_ms: number;
    finish_reason: 'stop' | 'max_iterations' | 'length' | 'content_filter' | 'error';
    model: string;
}

export interface AgentTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
    execute: (args: Record<string, any>) => Promise<{
        content: string;
        is_error: boolean;
    }>;
}

export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<{
    content: string;
    is_error: boolean;
}>;

// ────────────────────────────────────────────────────────────
// B-3: Auditor types
// ────────────────────────────────────────────────────────────

export type FindingSeverity = 'error' | 'warning' | 'info';

export type CheckKind =
    | 'muro_de_fuego'
    | 'zero_bifurcation'
    | 'service_no_wire'
    | 'mega_function'
    | 'direct_auth_users'
    | 'jsonb_column_audit';

export const ALL_CHECKS: CheckKind[] = [
    'muro_de_fuego',
    'zero_bifurcation',
    'service_no_wire',
    'mega_function',
    'direct_auth_users',
    'jsonb_column_audit'
];

export interface Finding {
    file: string;
    line?: number;
    kind: CheckKind;
    severity: FindingSeverity;
    message: string;
    snippet?: string;
}

export interface AuditorRequest {
    path?: string;
    glob?: string;
    checks?: CheckKind[];
    severity_threshold?: FindingSeverity;
    max_findings?: number;
}

export interface AuditorResponse {
    findings: Finding[];
    summary: {
        total: number;
        by_severity: Record<FindingSeverity, number>;
        by_kind: Record<CheckKind, number>;
    };
    truncated: boolean;
    checks_run: CheckKind[];
    files_scanned: number;
    latency_ms: number;
}

// ────────────────────────────────────────────────────────────
// B-4: Noter types
// ────────────────────────────────────────────────────────────

/** Actions the noter can perform against NotebookLM via nlm CLI. */
export type NoterAction = 'query' | 'add_source' | 'create_notebook' | 'list_notebooks' | 'doctor';

export interface NoterRequest {
    action: NoterAction;
    /** Notebook UUID (required for query/add_source). */
    notebook_id?: string;
    /** Conversation UUID (optional — keeps context across queries). */
    conversation_id?: string;
    /** The question or text to send (required for query). */
    question?: string;
    /** File path or URL to add as a source (required for add_source). */
    source?: string;
    /** Notebook title (required for create_notebook). */
    title?: string;
    /** Max wait in seconds for nlm CLI. Defaults to 60. */
    timeout_seconds?: number;
}

export interface NoterResponse {
    /** Action-specific primary output. */
    answer?: string;
    /** Notebooks listed (for list_notebooks). */
    notebooks?: Array<{ id: string; title: string }>;
    /** New notebook id (for create_notebook). */
    notebook_id?: string;
    /** Conversation id (for query, may be a new one if not provided). */
    conversation_id?: string;
    /** Raw stdout from nlm CLI (for debugging). */
    raw_stdout?: string;
    latency_ms: number;
}

/**
 * Result envelope for agent calls. Mirrors the pattern used in the
 * services layer of KOMO OS: always return { ok, ... } so callers
 * can branch on success without throwing.
 */
export type AgentResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: { kind: string; message: string; details?: any } };

/**
 * Configuration shared by all LLM-backed agents. Loaded from env at
 * server startup (see src/cli.ts).
 */
export interface LlmConfig {
    /** OpenAI-compatible API key. Required. */
    apiKey: string;
    /** Base URL. Defaults to https://api.minimax.io/v1 (MiniMax). */
    baseUrl: string;
    /** Default model id. Defaults to "MiniMax-M3". */
    defaultModel: string;
}
