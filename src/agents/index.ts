/**
 * Agent registry — re-exports for convenient imports.
 *
 * New agents (auditor, noter) will be added here as they land in
 * their respective sub-sprints.
 */

export { coderCall } from './coder.js';
export { coderAgent, stripThinkBlocks } from './coder-loop.js';
export type {
    AgentRequest,
    AgentResponse,
    AgentResult,
    AgentTool,
    AgentToolCallRecord,
    CoderRequest,
    CoderResponse,
    CoderUsage,
    LlmConfig,
    ToolExecutor
} from './types.js';
