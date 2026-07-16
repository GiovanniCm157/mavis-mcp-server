/**
 * Tool type definitions shared by all tools.
 */

import type { OpenAI } from 'openai';
import type { LlmConfig } from '../agents/types.js';
import type { Workspace } from '../workspace.js';
import type { State } from '../state.js';

/**
 * LLM client + config passed through the ToolContext. Optional —
 * if MINIMAX_API_KEY is not set, the server starts anyway and only
 * the mavis_coder tool returns a config_error. Other tools keep working.
 */
export interface LlmContext {
    client: OpenAI;
    config: LlmConfig;
}

/**
 * Context passed to every tool handler.
 */
export interface ToolContext {
    workspace: Workspace;
    state: State;
    /** Present when an LLM API key is configured. See LlmContext. */
    llm?: LlmContext;
}

/**
 * Tool definition: name, description, input schema, handler.
 *
 * The handler is async and returns an MCP CallToolResult:
 *   { content: [{ type: 'text', text: '...' }] }
 */
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
        additionalProperties?: boolean;
    };
    handler: (args: Record<string, any>, ctx: ToolContext) => Promise<{
        content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
        isError?: boolean;
    }>;
}
