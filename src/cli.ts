#!/usr/bin/env node
/**
 * CLI entrypoint for the Mavis MCP server.
 *
 * Usage:
 *   MAVIS_WORKSPACE=/path/to/project mavis-mcp
 *
 * Or with explicit args (advanced):
 *   mavis-mcp --workspace /path/to/project
 *
 * The server communicates over stdio using the MCP protocol.
 */

import { workspaceFromEnv, WorkspaceError } from './workspace.js';
import { State } from './state.js';
import { startServer } from './server.js';

async function main() {
    // Parse args (workspace can come from --workspace or MAVIS_WORKSPACE env).
    const args = process.argv.slice(2);
    let workspaceArg: string | undefined;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workspace' && args[i + 1]) {
            workspaceArg = args[i + 1];
            i++;
        } else if (args[i] === '--help' || args[i] === '-h') {
            printHelp();
            process.exit(0);
        } else if (args[i] === '--version' || args[i] === '-v') {
            console.log('mavis-mcp 0.1.0');
            process.exit(0);
        }
    }

    if (workspaceArg) {
        process.env.MAVIS_WORKSPACE = workspaceArg;
    }

    let workspace;
    try {
        workspace = workspaceFromEnv();
    } catch (err) {
        if (err instanceof WorkspaceError) {
            process.stderr.write(`[mavis-mcp] ${err.message}\n`);
            process.exit(1);
        }
        throw err;
    }

    const state = new State(workspace.root);
    await startServer({ workspace, state });
}

function printHelp() {
    console.log(`mavis-mcp — Mavis MCP Server

USAGE:
  MAVIS_WORKSPACE=/path/to/project mavis-mcp
  mavis-mcp --workspace /path/to/project

OPTIONS:
  --workspace <path>   Set workspace directory (alternative to MAVIS_WORKSPACE env)
  -h, --help           Show this help
  -v, --version        Show version

ENVIRONMENT:
  MAVIS_WORKSPACE      Absolute path to the project directory (required)

DESCRIPTION:
  Exposes Mavis's coding tools (bash, edit, git, supabase, run_tests, ...)
  as MCP tools for Claude Code. Communicates over stdio using the MCP protocol.
  See README.md for the full list of tools and configuration.
`);
}

main().catch((err) => {
    process.stderr.write(`[mavis-mcp] Fatal: ${err?.message || err}\n`);
    if (err?.stack) {
        process.stderr.write(`${err.stack}\n`);
    }
    process.exit(1);
});
