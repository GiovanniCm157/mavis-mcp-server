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
 * Callback to send a logging notification to the MCP client.
 * Wired by the server from Server.sendLoggingMessage.
 * The `data` object is included as MCP `_meta` and shown in the client UI.
 */
export type NotifyFn = (level: 'info' | 'warning' | 'error' | 'debug', message: string, data?: Record<string, any>) => void;

/**
 * Context passed to every tool handler.
 */
export interface ToolContext {
    workspace: Workspace;
    state: State;
    /** Present when an LLM API key is configured. See LlmContext. */
    llm?: LlmContext;
    /**
     * All registered tool definitions. Used by mavis_coder_agent to
     * expose the workspace tools to the LLM. Injected by the server
     * at startup to avoid circular imports.
     */
    toolRegistry?: ToolDef[];
    /**
     * Optional notification sink. When present, tools that emit progress
     * events (e.g. mavis_coder_agent) will pipe them to the MCP client
     * via notifications/message. Wired by the server at startup.
     */
    notify?: NotifyFn;
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
