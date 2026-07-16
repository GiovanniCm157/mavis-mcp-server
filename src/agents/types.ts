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
 *   - noter         : writes directly to NotebookLM via nlm CLI (B-4, future)
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
    /** Generated text content. */
    content: string;
    /** Token usage reported by the API. */
    usage: CoderUsage;
    /** Model id that actually responded. */
    model: string;
    /** Wall-clock latency in milliseconds. */
    latency_ms: number;
    /** Finish reason: "stop" | "length" | "content_filter" | "tool_calls" (B-2). */
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

/** Severity of an audit finding. */
export type FindingSeverity = 'error' | 'warning' | 'info';

/** Categories of KOMO antipatterns the auditor can detect. */
export type CheckKind =
    | 'muro_de_fuego'        // tenant isolation: query ops_* sin ownerId
    | 'zero_bifurcation'     // if/else por categoria en vez de getVerticalStrategy
    | 'service_no_wire'      // service function sin window.* en controller
    | 'mega_function'        // función > 200 líneas
    | 'direct_auth_users'    // referencia a auth.users en RLS
    | 'jsonb_column_audit';  // toca col JSONB sin documentar otras queries

export const ALL_CHECKS: CheckKind[] = [
    'muro_de_fuego',
    'zero_bifurcation',
    'service_no_wire',
    'mega_function',
    'direct_auth_users',
    'jsonb_column_audit'
];

/** A single finding. Like a linter diagnostic. */
export interface Finding {
    /** File where the issue was found (workspace-relative). */
    file: string;
    /** 1-indexed line number. May be undefined if the finding is file-level. */
    line?: number;
    /** Which check flagged it. */
    kind: CheckKind;
    /** Severity: 'error' (must fix), 'warning' (should fix), 'info' (FYI). */
    severity: FindingSeverity;
    /** Human-readable message describing the issue. */
    message: string;
    /** Optional code snippet (the line that triggered the finding). */
    snippet?: string;
}

export interface AuditorRequest {
    /**
     * File or directory to audit. Workspace-relative path. Defaults to
     * '.' (the entire workspace). If a directory, all supported source
     * files are scanned recursively.
     */
    path?: string;
    /**
     * Glob filter (e.g. "*.js", "*.ts"). Defaults to "*.{js,ts,tsx,jsx}".
     * Applied at file enumeration time — not the same as the path.
     */
    glob?: string;
    /**
     * Subset of checks to run. Defaults to ALL_CHECKS.
     */
    checks?: CheckKind[];
    /**
     * Minimum severity to report. Findings below this threshold are
     * silently dropped. Defaults to 'info' (all findings).
     */
    severity_threshold?: FindingSeverity;
    /**
     * Max number of findings to return. Defaults to 200. If exceeded,
     * the response includes a `truncated: true` flag and the first N
     * findings (sorted by severity, then by file/line).
     */
    max_findings?: number;
}

export interface AuditorResponse {
    /** All findings, sorted by severity (errors first) then file/line. */
    findings: Finding[];
    /** Aggregate stats. */
    summary: {
        total: number;
        by_severity: Record<FindingSeverity, number>;
        by_kind: Record<CheckKind, number>;
    };
    /** True if findings were truncated by max_findings. */
    truncated: boolean;
    /** Which checks were actually run (after filtering). */
    checks_run: CheckKind[];
    /** How many files were scanned. */
    files_scanned: number;
    /** Wall-clock latency. */
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
