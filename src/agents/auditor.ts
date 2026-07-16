/**
 * Mavis Auditor — read-only KOMO antipattern detector.
 *
 * Sprint B-3. A linter-style static analyzer that scans files for
 * KOMO-specific antipatterns. Read-only: never modifies the workspace.
 *
 * What it checks (regex-based, no AST):
 *   - muro_de_fuego     : query to ops_* table without ownerId / perfil.id filter
 *   - zero_bifurcation  : if/else branching on categoria instead of getVerticalStrategy
 *   - service_no_wire   : exported function in service file without window.* in controller
 *   - mega_function     : function body > 200 lines
 *   - direct_auth_users : reference to auth.users in RLS policy
 *   - jsonb_column_audit: touches JSONB column without cross-checking other queries
 *
 * This is a first-pass linter, NOT a semantic auditor. The LLM should
 * treat findings as guidance, not gospel. False positives are expected
 * (especially for the regex-based checks). For deeper analysis, use the
 * LLM itself in a second pass.
 *
 * Design notes:
 *   - Pure function: takes (request, workspaceRoot) and returns
 *     Promise<AgentResult<AuditorResponse>>. The workspace root is
 *     injected by the tool wrapper so we don't touch fs at module load.
 *   - Recursive directory walk with a glob filter. Skips node_modules,
 *     .git, dist, coverage, .mavis-state.json.
 *   - Findings are sorted by severity (errors first), then by file, line.
 *   - We cap the result at max_findings (default 200) and mark `truncated`.
 *   - No external deps for the checks themselves — just regex.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import type {
    AgentResult,
    AuditorRequest,
    AuditorResponse,
    CheckKind,
    Finding,
    FindingSeverity
} from './types.js';
import { ALL_CHECKS } from './types.js';

const DEFAULT_GLOB = '*.{js,ts,tsx,jsx,mjs,cjs,sql}';
const DEFAULT_MAX_FINDINGS = 200;
const MEGA_FUNCTION_LINES = 200;

const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    '.mavis-state.json',
    '.worktrees'
]);

// ────────────────────────────────────────────────────────────
// Check implementations
// ────────────────────────────────────────────────────────────

/**
 * Check 1: muro_de_fuego.
 * Detects queries to ops_* tables that lack an ownerId / perfil.id filter.
 * Heuristic: line contains `.from('ops_XYZ')` or `from('ops_XYZ', ...)`,
 * AND the next 5 lines don't contain ownerId or perfil.id.
 * False positives: pure SELECTs, RPCs, function definitions of the table.
 */
function checkMuroDeFuego(file: string, lines: string[]): Finding[] {
    const findings: Finding[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Match .from('ops_XXX') with possible whitespace, single or double quotes.
        const fromMatch = line.match(/\.from\(\s*['"](ops_[a-z_]+)['"]/);
        if (!fromMatch) continue;
        const table = fromMatch[1];

        // Look at this line + next 4 lines (5-line window) for ownerId/perfil.id.
        const window = lines.slice(i, i + 5).join('\n');
        const hasFilter = /ownerId|owner_id|perfil\.id|perfilId/i.test(window);

        if (!hasFilter) {
            findings.push({
                file,
                line: i + 1,
                kind: 'muro_de_fuego',
                severity: 'error',
                message: `Query to ${table} without ownerId/perfil.id filter (Muro de Fuego violation).`,
                snippet: line.trim().slice(0, 200)
            });
        }
    }
    return findings;
}

/**
 * Check 2: zero_bifurcation.
 * Detects branching on categoria instead of using getVerticalStrategy.
 * Patterns: `if (categoria ===`, `if (cat ===`, `if (cat === 'auto')`,
 * `switch (categoria)`, ternary `cat === 'X' ?`.
 */
function checkZeroBifurcation(file: string, lines: string[]): Finding[] {
    const findings: Finding[] = [];
    const pattern = /\b(if|else if|switch|\?)\s*\(?\s*(categoria|cat|cat_actual|perfil\.categoria)\s*(===|==|!==|!=)\s*['"](auto|belleza|retail|campo|wellness|field_service)['"]/;
    const switchPattern = /switch\s*\(\s*(categoria|cat|cat_actual|perfil\.categoria)\s*\)/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pattern.test(line)) {
            findings.push({
                file,
                line: i + 1,
                kind: 'zero_bifurcation',
                severity: 'error',
                message: 'Direct branching on categoria detected. Use getVerticalStrategy() instead (Zero-Bifurcation).',
                snippet: line.trim().slice(0, 200)
            });
        } else if (switchPattern.test(line)) {
            findings.push({
                file,
                line: i + 1,
                kind: 'zero_bifurcation',
                severity: 'error',
                message: 'switch on categoria detected. Use getVerticalStrategy() instead (Zero-Bifurcation).',
                snippet: line.trim().slice(0, 200)
            });
        }
    }
    return findings;
}

/**
 * Check 3: service_no_wire.
 * Detects exported async functions in service files that may not be
 * wired to a controller. Heuristic: file path contains 'service' or
 * 'servicio' AND there's an `export async function` declaration.
 *
 * v1 limitation: this check is coarser than the doctrine. The real
 * check is: "is there a corresponding window.* assignment in the
 * controller?" We can't easily cross-reference files without parsing,
 * so we just flag exported service functions for manual review.
 * The LLM should treat these as a TODO list, not as definitive bugs.
 */
function checkServiceNoWire(file: string, lines: string[]): Finding[] {
    const isServiceFile = /service|servicio/i.test(file);
    if (!isServiceFile) return [];
    const findings: Finding[] = [];
    const pattern = /export\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(pattern);
        if (!m) continue;
        const fnName = m[1];
        // Skip if it's a class definition or already a wiring helper.
        if (fnName === 'constructor') continue;
        findings.push({
            file,
            line: i + 1,
            kind: 'service_no_wire',
            severity: 'warning',
            message: `Service function "${fnName}" — verify it's exposed via window.* in the controller.`,
            snippet: lines[i].trim().slice(0, 200)
        });
    }
    return findings;
}

/**
 * Check 4: mega_function.
 * Counts lines between `function NAME(` or `=> {` and the matching
 * closing `}`. Rough heuristic — we count opening braces in the
 * function body vs closing braces, but with a one-pass approximation
 * (increment on `{`, decrement on `}`). A true parser would be better
 * but adds complexity. v1: count function bodies > 200 lines.
 */
function checkMegaFunction(file: string, lines: string[]): Finding[] {
    const findings: Finding[] = [];
    // Match function declarations: function NAME( ... ) { or const NAME = (...) => {
    const fnStart = /^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{|^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{/;

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(fnStart);
        if (!m) continue;
        const fnName = m[1] || m[2];

        // Count braces from here forward, tracking string/comment state
        // is too complex for v1. Use a simple approximation: balance
        // { and } across lines until we hit 0 (or run out of file).
        let depth = 0;
        let endLine = i;
        let started = false;
        for (let j = i; j < lines.length; j++) {
            const line = lines[j];
            for (const ch of line) {
                if (ch === '{') {
                    depth++;
                    started = true;
                } else if (ch === '}') {
                    depth--;
                }
            }
            if (started && depth === 0) {
                endLine = j;
                break;
            }
        }
        const bodyLines = endLine - i + 1;
        if (bodyLines > MEGA_FUNCTION_LINES) {
            findings.push({
                file,
                line: i + 1,
                kind: 'mega_function',
                severity: 'warning',
                message: `Function "${fnName}" is ${bodyLines} lines (threshold: ${MEGA_FUNCTION_LINES}). Consider splitting.`,
                snippet: lines[i].trim().slice(0, 200)
            });
        }
    }
    return findings;
}

/**
 * Check 5: direct_auth_users.
 * Detects references to auth.users in SQL/RPC/RLS code. The doctrine is
 * to use a profiles table or auth.uid() instead.
 */
function checkDirectAuthUsers(file: string, lines: string[]): Finding[] {
    const findings: Finding[] = [];
    // Look for the pattern: from auth.users, JOIN auth.users,
    // REFERENCES auth.users (case insensitive).
    const pattern = /\b(?:from|join|references|references\s+table)\s+auth\.users\b/i;
    for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
            findings.push({
                file,
                line: i + 1,
                kind: 'direct_auth_users',
                severity: 'error',
                message: 'Reference to auth.users detected. Use a profiles table or auth.uid() instead (doctrine: never reference auth.users directly in RLS).',
                snippet: lines[i].trim().slice(0, 200)
            });
        }
    }
    return findings;
}

/**
 * Check 6: jsonb_column_audit (heuristic, info-level).
 * Detects reads/writes to known JSONB columns and flags for cross-checking
 * other queries that touch the same table. The actual audit is the
 * reviewer's job — we just say "you touched ops_X.atributos, did you
 * also check the other 3 places that read it?"
 *
 * Known JSONB columns in KOMO (per sprint 28-30):
 *   ops_inventario.atributos, .componentes_kit, .imagen_url (legacy)
 *   ops_activos.metadata, .imagenes
 *   ops_ordenes.atributos (if exists)
 *   ops_deals.metadata, .custom_fields
 */
const JSONB_COLUMNS: Array<{ table: string; column: string }> = [
    { table: 'ops_inventario', column: 'atributos' },
    { table: 'ops_inventario', column: 'componentes_kit' },
    { table: 'ops_activos', column: 'metadata' },
    { table: 'ops_activos', column: 'imagenes' },
    { table: 'ops_deals', column: 'metadata' },
    { table: 'ops_deals', column: 'custom_fields' }
];

function checkJsonbColumnAudit(file: string, lines: string[]): Finding[] {
    const findings: Finding[] = [];
    const triggered = new Set<string>();

    // Cross-line: for each line, build a small window (this line + next 2)
    // to match the typical Supabase query pattern where .from(...) and
    // .select('atributos') are on separate lines.
    for (let i = 0; i < lines.length; i++) {
        const window = lines.slice(i, i + 3).join('\n');
        for (const { table, column } of JSONB_COLUMNS) {
            // Same-line: table.col, JSONB operators (->>, ->).
            // Cross-line: from('table') ... select('column') with any content between.
            const sameLine = new RegExp(`\\b${table}\\.${column}\\b|\\b${column}\\s*->>\\b|\\b${column}\\s*->\\b`);
            const crossLine = new RegExp(`\\bfrom\\s*\\(\\s*['"]${table}['"][\\s\\S]{0,300}?\\b${column}\\b`);
            if (sameLine.test(window) || crossLine.test(window)) {
                const key = `${table}.${column}`;
                if (!triggered.has(key)) {
                    triggered.add(key);
                    findings.push({
                        file,
                        line: i + 1,
                        kind: 'jsonb_column_audit',
                        severity: 'info',
                        message: `Touches JSONB column ${key}. Cross-check ALL queries that read this table (JSONB column doctrine).`,
                        snippet: window.split('\n')[0].trim().slice(0, 200)
                    });
                }
            }
        }
    }
    return findings;
}

const CHECK_FNS: Record<CheckKind, (file: string, lines: string[]) => Finding[]> = {
    muro_de_fuego: checkMuroDeFuego,
    zero_bifurcation: checkZeroBifurcation,
    service_no_wire: checkServiceNoWire,
    mega_function: checkMegaFunction,
    direct_auth_users: checkDirectAuthUsers,
    jsonb_column_audit: checkJsonbColumnAudit
};

// ────────────────────────────────────────────────────────────
// File enumeration
// ────────────────────────────────────────────────────────────

/**
 * Recursively walk a directory, collecting files matching the glob.
 * Skips SKIP_DIRS. Returns workspace-relative paths.
 */
function walkDir(root: string, dir: string, out: string[]): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return; // unreadable directory, skip
    }
    for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) {
            walkDir(root, full, out);
        } else if (st.isFile()) {
            out.push(relative(root, full));
        }
    }
}

/**
 * Convert a simple glob like "*.js" or "*.{js,ts}" to a regex.
 * Supports only the subset we need: leading *, brace alternatives.
 */
function globToRegex(glob: string): RegExp {
    // Helper: escape glob special chars (dots etc) and translate * → .*
    const escapeGlob = (g: string): string =>
        g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');

    // Brace expansion: "*.{js,ts}" → ("*.js"|"*.ts") with each alternative
    // escaped properly. This is critical when the prefix contains a *
    // because naive string concat produces invalid regex like (*.js|*.ts).
    if (glob.includes('{') && glob.includes('}')) {
        const m = glob.match(/^(.*)\{(.+)\}(.*)$/);
        if (m) {
            const [, prefix, alts, suffix] = m;
            const altsEscaped = alts.split(',').map(a => escapeGlob(prefix + a.trim() + suffix));
            return new RegExp(`^(${altsEscaped.join('|')})$`);
        }
    }
    return new RegExp(`^${escapeGlob(glob)}$`);
}

function matchesGlob(filename: string, globRe: RegExp): boolean {
    return globRe.test(filename);
}

// ────────────────────────────────────────────────────────────
// Severity filter + sort
// ────────────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

function filterAndSort(
    findings: Finding[],
    threshold: FindingSeverity,
    max: number
): { filtered: Finding[]; truncated: boolean } {
    const t = SEVERITY_ORDER[threshold];
    const filtered = findings
        .filter(f => SEVERITY_ORDER[f.severity] <= t)
        .sort((a, b) => {
            const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
            if (s !== 0) return s;
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            return (a.line || 0) - (b.line || 0);
        });
    return {
        filtered,
        truncated: filtered.length > max
    };
}

function summarize(findings: Finding[]): AuditorResponse['summary'] {
    const by_severity: Record<FindingSeverity, number> = { error: 0, warning: 0, info: 0 };
    const by_kind: Record<CheckKind, number> = {
        muro_de_fuego: 0,
        zero_bifurcation: 0,
        service_no_wire: 0,
        mega_function: 0,
        direct_auth_users: 0,
        jsonb_column_audit: 0
    };
    for (const f of findings) {
        by_severity[f.severity]++;
        by_kind[f.kind]++;
    }
    return { total: findings.length, by_severity, by_kind };
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export async function runAudit(
    req: AuditorRequest,
    workspaceRoot: string
): Promise<AgentResult<AuditorResponse>> {
    const tStart = process.hrtime.bigint();

    // Defaults.
    const targetPath = req.path || '.';
    const glob = req.glob || DEFAULT_GLOB;
    const severity_threshold = req.severity_threshold || 'info';
    const max_findings = req.max_findings ?? DEFAULT_MAX_FINDINGS;
    const checks = req.checks && req.checks.length > 0
        ? req.checks
        : ALL_CHECKS;

    // Validate checks.
    for (const c of checks) {
        if (!ALL_CHECKS.includes(c)) {
            return {
                ok: false,
                error: {
                    kind: 'invalid_request',
                    message: `Unknown check: "${c}". Valid: ${ALL_CHECKS.join(', ')}`
                }
            };
        }
    }

    // Resolve target.
    const absTarget = join(workspaceRoot, targetPath);
    let st;
    try {
        st = statSync(absTarget);
    } catch (err: any) {
        return {
            ok: false,
            error: {
                kind: 'invalid_request',
                message: `Path not found: ${targetPath} (resolved to ${absTarget})`
            }
        };
    }

    // Enumerate files.
    const files: string[] = [];
    if (st.isDirectory()) {
        walkDir(workspaceRoot, absTarget, files);
    } else if (st.isFile()) {
        files.push(relative(workspaceRoot, absTarget));
    }

    // Apply glob filter.
    const globRe = globToRegex(glob);
    const sourceExts = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.sql']);
    const matched = files.filter(f => {
        // Quick extension check first (cheap).
        if (!sourceExts.has(extname(f))) return false;
        return matchesGlob(f, globRe);
    });

    // Run checks per file.
    const allFindings: Finding[] = [];
    for (const file of matched) {
        const abs = join(workspaceRoot, file);
        let content: string;
        try {
            content = readFileSync(abs, 'utf8');
        } catch {
            continue; // unreadable, skip
        }
        const lines = content.split('\n');
        for (const check of checks) {
            const fn = CHECK_FNS[check];
            const findings = fn(file, lines);
            allFindings.push(...findings);
        }
    }

    // Filter + sort + truncate.
    const { filtered, truncated } = filterAndSort(allFindings, severity_threshold, max_findings);
    const summary = summarize(filtered);

    const tEnd = process.hrtime.bigint();
    const latency_ms = Number(tEnd - tStart) / 1_000_000;

    return {
        ok: true,
        data: {
            findings: filtered.slice(0, max_findings),
            summary,
            truncated,
            checks_run: checks,
            files_scanned: matched.length,
            latency_ms: Math.round(latency_ms * 100) / 100
        }
    };
}
