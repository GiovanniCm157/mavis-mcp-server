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
 *
 * Configuration:
 *   .env file at the workspace root or one level up is loaded at startup
 *   for LLM API keys (MINIMAX_API_KEY, MINIMAX_BASE_URL, MINIMAX_MODEL).
 *   If MINIMAX_API_KEY is missing, the server starts anyway and only
 *   the mavis_coder tool returns a config_error. Other tools keep working.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import OpenAI from 'openai';

import { workspaceFromEnv, WorkspaceError } from './workspace.js';
import { State } from './state.js';
import { startServer } from './server.js';
import type { LlmConfig } from './agents/types.js';
import type { LlmContext } from './tools/types.js';

/**
 * Minimal .env loader — avoids pulling in dotenv as a dependency.
 * Reads KEY=VALUE lines, ignores comments (#) and blank lines.
 * Does not override existing process.env values (env wins over .env).
 */
function loadEnvFile(filePath: string): void {
    if (!existsSync(filePath)) return;
    try {
        const raw = readFileSync(filePath, 'utf8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            // Strip surrounding quotes if present.
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            // Env wins — don't override.
            if (process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    } catch (err) {
        process.stderr.write(`[mavis-mcp] .env load failed (${filePath}): ${err}\n`);
    }
}

/**
 * Build the LLM context (OpenAI client + config) from env.
 * Returns undefined when MINIMAX_API_KEY is not set — the server
 * then starts without LLM capability and only mavis_coder fails.
 */
function buildLlmContext(): LlmContext | undefined {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
        return undefined;
    }
    const baseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
    const defaultModel = process.env.MINIMAX_MODEL || 'MiniMax-M3';
    const config: LlmConfig = { apiKey, baseUrl, defaultModel };
    const client = new OpenAI({ apiKey, baseURL: baseUrl });
    return { client, config };
}

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

    // Load .env from workspace root (or one level up, for monorepo patterns).
    loadEnvFile(resolve(workspace.root, '.env'));
    loadEnvFile(resolve(dirname(workspace.root), '.env'));

    const llm = buildLlmContext();
    if (llm) {
        process.stderr.write(
            `[mavis-mcp] LLM enabled: model=${llm.config.defaultModel} baseUrl=${llm.config.baseUrl}\n`
        );
    } else {
        process.stderr.write(
            '[mavis-mcp] LLM disabled: MINIMAX_API_KEY not set. mavis_coder will return config_error.\n'
        );
    }

    const state = new State(workspace.root);
    await startServer({ workspace, state, llm });
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
