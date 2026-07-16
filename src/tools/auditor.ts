/**
 * mavis_auditor tool — wraps the KOMO antipattern auditor.
 *
 * Sprint B-3. Read-only: scans files for KOMO-specific antipatterns
 * and returns a structured findings list. No LLM call required.
 *
 * Input:
 *   path               (string, optional — file or dir, default ".")
 *   glob               (string, optional — default "*.{js,ts,tsx,jsx,mjs,cjs}")
 *   checks             (string[], optional — subset of: muro_de_fuego,
 *                       zero_bifurcation, service_no_wire, mega_function,
 *                       direct_auth_users, jsonb_column_audit)
 *   severity_threshold (string, optional — "error" | "warning" | "info", default "info")
 *   max_findings       (int, optional — default 200)
 *
 * Output:
 *   { ok: true, data: { findings, summary, truncated, checks_run,
 *                        files_scanned, latency_ms } }
 *
 * Use cases:
 *   - Pre-commit hook: scan changed files for error-level findings
 *   - LLM agent: 'audit this file before refactoring'
 *   - Manual review: 'show me all mega_functions > 300 lines'
 */

import { runAudit } from '../agents/auditor.js';
import type { AuditorRequest, CheckKind, FindingSeverity } from '../agents/types.js';
import { ALL_CHECKS } from '../agents/types.js';
import type { ToolDef } from './types.js';

const VALID_SEVERITIES: FindingSeverity[] = ['error', 'warning', 'info'];

export const auditorTool: ToolDef = {
    name: 'mavis_auditor',
    description:
        'Read-only KOMO antipattern detector. Scans files for: muro_de_fuego ' +
        '(queries to ops_* without ownerId), zero_bifurcation (if/else on categoria), ' +
        'service_no_wire (exported service function — verify window.* wire), ' +
        'mega_function (>200 lines), direct_auth_users (RLS referencing auth.users), ' +
        'jsonb_column_audit (touches JSONB col — cross-check other queries). ' +
        'Returns findings with severity, file, line. Read-only — never modifies the workspace. ' +
        'Use before commits, before refactors, or as a code review assistant.',
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'File or directory to audit. Workspace-relative. Default: "." (whole workspace).'
            },
            glob: {
                type: 'string',
                description: 'File pattern. Default: "*.{js,ts,tsx,jsx,mjs,cjs,sql}".'
            },
            checks: {
                type: 'array',
                items: { type: 'string', enum: ALL_CHECKS as string[] },
                description: 'Subset of checks to run. Default: all.'
            },
            severity_threshold: {
                type: 'string',
                enum: VALID_SEVERITIES as string[],
                description: 'Minimum severity to report. Default: "info" (all).'
            },
            max_findings: {
                type: 'integer',
                minimum: 1,
                maximum: 1000,
                description: 'Cap on findings returned. Default: 200.'
            }
        },
        additionalProperties: false
    },
    handler: async (args, ctx) => {
        // Validate severity_threshold.
        const sev = (args.severity_threshold ?? 'info') as string;
        if (!VALID_SEVERITIES.includes(sev as FindingSeverity)) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        ok: false,
                        error: {
                            kind: 'invalid_request',
                            message: `severity_threshold must be one of: ${VALID_SEVERITIES.join(', ')}. Got: ${sev}`
                        }
                    }, null, 2)
                }],
                isError: true
            };
        }

        // Validate checks.
        const checksInput = Array.isArray(args.checks) ? args.checks.map(String) : undefined;
        if (checksInput) {
            for (const c of checksInput) {
                if (!ALL_CHECKS.includes(c as CheckKind)) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                ok: false,
                                error: {
                                    kind: 'invalid_request',
                                    message: `Unknown check: "${c}". Valid: ${ALL_CHECKS.join(', ')}`
                                }
                            }, null, 2)
                        }],
                        isError: true
                    };
                }
            }
        }

        const req: AuditorRequest = {
            path: args.path !== undefined ? String(args.path) : undefined,
            glob: args.glob !== undefined ? String(args.glob) : undefined,
            checks: checksInput as CheckKind[] | undefined,
            severity_threshold: sev as FindingSeverity,
            max_findings: args.max_findings !== undefined ? Number(args.max_findings) : undefined
        };

        const result = await runAudit(req, ctx.workspace.root);

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(result, null, 2)
            }],
            isError: !result.ok
        };
    }
};
