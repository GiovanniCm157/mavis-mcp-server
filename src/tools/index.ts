/**
 * Tool registry — exports all tools as an array + individual re-exports.
 * Imported by server.ts to register with the MCP server.
 */

import { bashTool } from './bash.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { searchTool } from './search.js';
import { gitTool } from './git.js';
import { supabaseTool } from './supabase.js';
import { runTestsTool } from './run_tests.js';
import { stateTool } from './state.js';
import { coderTool } from './coder.js';
import { coderAgentTool } from './coder-agent.js';
import { auditorTool } from './auditor.js';
import { noterTool } from './noter.js';
import type { ToolDef } from './types.js';

export const tools: ToolDef[] = [
    bashTool,
    readTool,
    writeTool,
    editTool,
    searchTool,
    gitTool,
    supabaseTool,
    runTestsTool,
    stateTool,
    coderTool,
    coderAgentTool,
    auditorTool,
    noterTool
];

// Re-export individual tools so tests can import them directly.
export {
    bashTool,
    readTool,
    writeTool,
    editTool,
    searchTool,
    gitTool,
    supabaseTool,
    runTestsTool,
    stateTool,
    coderTool,
    coderAgentTool,
    auditorTool,
    noterTool
};

export type { ToolDef, ToolContext, LlmContext } from './types.js';
