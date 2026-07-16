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
 *   - auditor       : read-only antipattern detector (B-3, future)
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

/**
 * Request to run a multi-step agent loop. The model can call any
 * of the tools in `tools` (or all available if undefined) until it
 * produces a final response (finish_reason=stop) or `max_iterations`
 * is reached.
 */
export interface AgentRequest extends CoderRequest {
    /**
     * Max agent iterations. Each iteration is one round-trip to the LLM
     * (which may include multiple tool calls). Defaults to 10. Hard cap 30.
     * Going past 30 means your prompt is too vague — refactor it.
     */
    max_iterations?: number;
    /**
     * Subset of tool names to expose to the LLM. If undefined, ALL
     * registered mavis_* tools are available EXCEPT the agent itself
     * (mavis_coder_agent) and single-shot mavis_coder — that would be
     * recursion. To re-enable them, pass them explicitly here.
     */
    tools?: string[];
    /**
     * Tool choice strategy. Defaults to "auto" (LLM decides when to call).
     * "required" forces at least one tool call per iteration.
     * "none" forces text-only (effectively disables tool calling).
     * Or pass { type: 'function', function: { name: 'X' } } to force a specific tool.
     */
    tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
}

/**
 * A single tool invocation the agent made during its loop.
 * Used for transparency and debugging — included in the response.
 */
export interface AgentToolCallRecord {
    /** 1-indexed iteration number (1 = first call to LLM). */
    iteration: number;
    /** Name of the tool invoked. */
    tool_name: string;
    /** Args passed to the tool (parsed JSON). */
    tool_args: Record<string, any>;
    /** Truncated result text (first 500 chars) for readability. */
    result_summary: string;
    /** Whether the tool returned isError=true. */
    is_error: boolean;
    /** Wall-clock duration of this specific tool call. */
    duration_ms: number;
}

export interface AgentResponse {
    /** Final assistant content (think blocks stripped). */
    final_content: string;
    /** Number of LLM round-trips (1 = no tool calls, N = N iterations). */
    iterations: number;
    /** All tool calls made, in order, across all iterations. */
    tool_calls: AgentToolCallRecord[];
    /** Aggregated token usage across all iterations. */
    total_usage: CoderUsage;
    /** Wall-clock latency for the entire agent run. */
    latency_ms: number;
    /** Why the loop terminated. */
    finish_reason: 'stop' | 'max_iterations' | 'length' | 'content_filter' | 'error';
    /** Model id that actually responded (last iteration). */
    model: string;
}

/**
 * Minimal contract for a tool that the agent loop can invoke.
 * Decoupled from the MCP ToolDef so we can test the loop with mocks.
 */
export interface AgentTool {
    name: string;
    description: string;
    /** OpenAI-compatible JSON schema for the tool's input. */
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
    /**
     * Execute the tool with the given args. Return a string result.
     * Throw or return is_error=true to signal failure to the LLM.
     */
    execute: (args: Record<string, any>) => Promise<{
        content: string;
        is_error: boolean;
    }>;
}

/**
 * Callback to execute a tool by name. Lets the agent layer stay
 * decoupled from the MCP tool registry (the tool wrapper provides it).
 */
export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<{
    content: string;
    is_error: boolean;
}>;

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
