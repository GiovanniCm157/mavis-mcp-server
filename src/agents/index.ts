/**
 * Agent registry — re-exports for convenient imports.
 *
 * New agents (auditor, noter) will be added here as they land in
 * their respective sub-sprints.
 */

export { coderCall } from './coder.js';
export type {
    AgentResult,
    CoderRequest,
    CoderResponse,
    CoderUsage,
    LlmConfig
} from './types.js';
