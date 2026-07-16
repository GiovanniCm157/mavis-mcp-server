/**
 * Shared types for Mavis agents.
 *
 * An "agent" is a typed wrapper around an LLM call (or call loop) that
 * adds project-specific behavior. Agents live in src/agents/ and are
 * independent of MCP — they're exposed to clients via tool wrappers
 * in src/tools/.
 *
 * Current agents:
 *   - coder    : MiniMax-M3 single-shot text generation (B-1)
 *   - coder    : MiniMax-M3 with tool-calling agent loop (B-2, future)
 *   - auditor  : read-only antipattern detector (B-3, future)
 *   - noter    : writes directly to NotebookLM via nlm CLI (B-4, future)
 */

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
