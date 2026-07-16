/**
 * Agent registry — re-exports for convenient imports.
 */

export { coderCall } from './coder.js';
export { coderAgent, stripThinkBlocks } from './coder-loop.js';
export { runAudit } from './auditor.js';
export { runNoter, type NlmExec } from './noter.js';
export type {
    AgentRequest,
    AgentResponse,
    AgentResult,
    AgentTool,
    AgentToolCallRecord,
    AuditorRequest,
    AuditorResponse,
    CheckKind,
    CoderRequest,
    CoderResponse,
    CoderUsage,
    Finding,
    FindingSeverity,
    LlmConfig,
    NoterAction,
    NoterRequest,
    NoterResponse,
    ToolExecutor
} from './types.js';
export { ALL_CHECKS } from './types.js';
