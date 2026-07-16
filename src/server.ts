/**
 * Mavis MCP Server
 *
 * Wires up the @modelcontextprotocol/sdk Server with our tools.
 * Communicates over stdio (the default for Claude Code MCP servers).
 */

import { Server } from '@modelcontextprotocol/sdk/server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { tools, type ToolDef, type ToolContext, type LlmContext } from './tools/index.js';
import type { Workspace } from './workspace.js';
import type { State } from './state.js';

export interface ServerOptions {
    workspace: Workspace;
    state: State;
    /** Optional LLM client + config. When undefined, mavis_coder returns config_error. */
    llm?: LlmContext;
}

/**
 * Create and configure the MCP server. Returns a connected server instance.
 */
export async function startServer(opts: ServerOptions): Promise<Server> {
    const ctx: ToolContext = {
        workspace: opts.workspace,
        state: opts.state,
        llm: opts.llm
    };

    const server = new Server(
        {
            name: 'mavis-mcp-server',
            version: '0.1.0'
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    // List tools handler.
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: tools.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema
            }))
        };
    });

    // Call tool handler.
    server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
        const { name, arguments: args } = request.params;
        const tool = tools.find(t => t.name === name);
        if (!tool) {
            return {
                content: [{ type: 'text', text: `Error: unknown tool "${name}".` }],
                isError: true
            };
        }

        try {
            const result = await tool.handler(args || {}, ctx);
            // Save state after each call (non-blocking).
            try {
                opts.state.save();
            } catch (err) {
                // Don't fail the tool call if state save fails.
                // Just log to stderr (Claude Code captures it).
                process.stderr.write(`[mavis-mcp] state save failed: ${err}\n`);
            }
            return result;
        } catch (err: any) {
            const message = err?.message || String(err);
            return {
                content: [{ type: 'text', text: `Error in ${name}: ${message}` }],
                isError: true
            };
        }
    });

    // Connect to stdio transport (Claude Code's default).
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log to stderr (stdout is reserved for MCP protocol).
    process.stderr.write(
        `[mavis-mcp] Server started. Workspace: ${opts.workspace.root}\n` +
        `[mavis-mcp] Tools registered: ${tools.map(t => t.name).join(', ')}\n`
    );

    return server;
}
