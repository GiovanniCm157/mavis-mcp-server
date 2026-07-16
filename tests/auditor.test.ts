/**
 * Tests for the mavis_auditor tool and the runAudit function.
 *
 * Sprint B-3. We write fixture files in a temp dir, then call
 * runAudit() against it. The tool wrapper is tested separately.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAudit } from '../src/agents/auditor.js';
import { auditorTool } from '../src/tools/auditor.js';
import { createWorkspace } from '../src/workspace.js';
import { State } from '../src/state.js';
import type { ToolContext } from '../src/tools/types.js';

let workDir: string;

beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mavis-auditor-'));
});

afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
});

/**
 * Write a fixture file. Convenience helper.
 */
function fixture(rel: string, content: string): void {
    const full = join(workDir, rel);
    const dir = full.substring(0, full.lastIndexOf('/'));
    if (dir && dir !== full) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(full, content);
}

// ────────────────────────────────────────────────────────────
// runAudit
// ────────────────────────────────────────────────────────────

describe('runAudit (read-only KOMO antipattern detector)', () => {
    it('returns ok with empty findings when no issues', async () => {
        fixture('src/clean.js', 'export function add(a, b) { return a + b; }\n');
        const result = await runAudit({ path: '.' }, workDir);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toEqual([]);
            expect(result.data.summary.total).toBe(0);
            expect(result.data.files_scanned).toBe(1);
        }
    });

    it('flags muro_de_fuego: query to ops_X without ownerId', async () => {
        fixture('src/bad.js', `
            const x = await supabase
                .from('ops_inventario')
                .select('*');
        `);
        const result = await runAudit(
            { path: '.', checks: ['muro_de_fuego'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toHaveLength(1);
            expect(result.data.findings[0].kind).toBe('muro_de_fuego');
            expect(result.data.findings[0].severity).toBe('error');
            expect(result.data.findings[0].message).toContain('ops_inventario');
        }
    });

    it('does NOT flag muro_de_fuego when ownerId is present in 5-line window', async () => {
        fixture('src/ok.js', `
            const x = await supabase
                .from('ops_inventario')
                .select('*')
                .eq('ownerId', ownerId)
                .single();
        `);
        const result = await runAudit(
            { path: '.', checks: ['muro_de_fuego'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toEqual([]);
        }
    });

    it('does NOT flag muro_de_fuego when perfil.id is in the window', async () => {
        fixture('src/ok2.js', `
            const x = await supabase
                .from('ops_ordenes')
                .select('*')
                .eq('owner_id', perfil.id);
        `);
        const result = await runAudit(
            { path: '.', checks: ['muro_de_fuego'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toEqual([]);
        }
    });

    it('flags zero_bifurcation: if (categoria === "auto")', async () => {
        fixture('src/bad.js', `
            if (categoria === 'auto') {
                doAuto();
            } else if (categoria === 'belleza') {
                doBelleza();
            }
        `);
        const result = await runAudit(
            { path: '.', checks: ['zero_bifurcation'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings.length).toBeGreaterThanOrEqual(2);
            expect(result.data.findings.every(f => f.kind === 'zero_bifurcation')).toBe(true);
        }
    });

    it('flags zero_bifurcation: switch on categoria', async () => {
        fixture('src/bad.js', `
            switch (perfil.categoria) {
                case 'auto': return autoStuff();
                case 'belleza': return beautyStuff();
            }
        `);
        const result = await runAudit(
            { path: '.', checks: ['zero_bifurcation'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings.some(f => f.message.includes('switch'))).toBe(true);
        }
    });

    it('flags service_no_wire: exported function in a service file', async () => {
        fixture('src/inventarioservice.js', `
            export async function listarActivos() { return []; }
            export async function guardarActivo() { return null; }
        `);
        const result = await runAudit(
            { path: '.', checks: ['service_no_wire'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toHaveLength(2);
            expect(result.data.findings[0].message).toContain('listarActivos');
            expect(result.data.findings[1].message).toContain('guardarActivo');
        }
    });

    it('does NOT flag service_no_wire for non-service files', async () => {
        fixture('src/utils.js', `
            export function add(a, b) { return a + b; }
        `);
        const result = await runAudit(
            { path: '.', checks: ['service_no_wire'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toEqual([]);
        }
    });

    it('flags mega_function: function body > 200 lines', async () => {
        // Build a 250-line function.
        const body = Array(250).fill('  doSomething();').join('\n');
        fixture('src/big.js', `function bigFn() {\n${body}\n}\n`);
        const result = await runAudit(
            { path: '.', checks: ['mega_function'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toHaveLength(1);
            expect(result.data.findings[0].kind).toBe('mega_function');
            expect(result.data.findings[0].message).toMatch(/250|251|252 lines/);
        }
    });

    it('does NOT flag mega_function for short functions', async () => {
        fixture('src/small.js', `function small() {\n  return 1;\n}\n`);
        const result = await runAudit(
            { path: '.', checks: ['mega_function'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toEqual([]);
        }
    });

    it('flags direct_auth_users in SQL/RLS', async () => {
        fixture('supabase/policies.sql', `
            CREATE POLICY "users can read own" ON ops_inventario
            FOR SELECT USING (auth.uid() = (SELECT id FROM auth.users WHERE id = auth.uid()));
        `);
        const result = await runAudit(
            { path: '.', checks: ['direct_auth_users'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toHaveLength(1);
            expect(result.data.findings[0].kind).toBe('direct_auth_users');
            expect(result.data.findings[0].severity).toBe('error');
        }
    });

    it('flags jsonb_column_audit: reads ops_inventario.atributos', async () => {
        fixture('src/svc.js', `
            const r = await supabase
                .from('ops_inventario')
                .select('atributos');
        `);
        const result = await runAudit(
            { path: '.', checks: ['jsonb_column_audit'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toHaveLength(1);
            expect(result.data.findings[0].kind).toBe('jsonb_column_audit');
            expect(result.data.findings[0].severity).toBe('info');
            expect(result.data.findings[0].message).toContain('ops_inventario.atributos');
        }
    });

    it('de-duplicates jsonb_column_audit findings per (table,column)', async () => {
        fixture('src/svc.js', `
            const r1 = await supabase.from('ops_inventario').select('atributos');
            const r2 = await supabase.from('ops_inventario').select('atributos');
            const r3 = await supabase.from('ops_inventario').select('atributos');
        `);
        const result = await runAudit(
            { path: '.', checks: ['jsonb_column_audit'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            // Same table.col on 3 lines → only 1 finding.
            expect(result.data.findings).toHaveLength(1);
        }
    });

    it('rejects unknown check', async () => {
        fixture('src/clean.js', 'export const x = 1;\n');
        const result = await runAudit(
            { path: '.', checks: ['nonexistent_check'] as any },
            workDir
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
        }
    });

    it('returns error when path does not exist', async () => {
        const result = await runAudit({ path: 'nope/' }, workDir);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.kind).toBe('invalid_request');
            expect(result.error.message).toContain('not found');
        }
    });

    it('skips node_modules, .git, dist', async () => {
        fixture('node_modules/dep.js', `
            supabase.from('ops_inventario').select('*'); // would be flagged
        `);
        fixture('src/clean.js', 'export const x = 1;\n');
        const result = await runAudit(
            { path: '.', checks: ['muro_de_fuego'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            // node_modules/dep.js should be skipped, so no findings.
            expect(result.data.findings).toEqual([]);
            expect(result.data.files_scanned).toBe(1);
        }
    });

    it('respects severity_threshold: drops info findings when set to warning', async () => {
        fixture('src/svc.js', `
            const r = await supabase.from('ops_inventario').select('atributos');
        `);
        // With no threshold, jsonb_column_audit (info) should appear.
        const r1 = await runAudit(
            { path: '.', checks: ['jsonb_column_audit'] },
            workDir
        );
        expect(r1.ok).toBe(true);
        if (r1.ok) expect(r1.data.findings).toHaveLength(1);

        // With threshold=warning, info-level findings are dropped.
        const r2 = await runAudit(
            { path: '.', checks: ['jsonb_column_audit'], severity_threshold: 'warning' },
            workDir
        );
        expect(r2.ok).toBe(true);
        if (r2.ok) {
            expect(r2.data.findings).toEqual([]);
            // But summary still reflects that we ran 0 findings at this threshold.
            expect(r2.data.summary.by_severity.info).toBe(0);
        }
    });

    it('sorts findings by severity (errors first), then file/line', async () => {
        fixture('src/zzz.js', `
            const r = await supabase.from('ops_inventario').select('atributos');
        `);
        fixture('src/aaa.js', `
            const x = await supabase.from('ops_inventario').select('*');
        `);
        const result = await runAudit(
            { path: '.' }, // all checks
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            // First finding should be the error (muro_de_fuego in aaa.js, line 2).
            expect(result.data.findings[0].severity).toBe('error');
            expect(result.data.findings[0].file).toBe('src/aaa.js');
        }
    });

    it('truncates findings at max_findings and sets truncated flag', async () => {
        // Generate 5 distinct service functions (all in a "service" file).
        fixture('src/myservice.js', `
            export async function fn1() { return 1; }
            export async function fn2() { return 2; }
            export async function fn3() { return 3; }
            export async function fn4() { return 4; }
            export async function fn5() { return 5; }
        `);
        const result = await runAudit(
            { path: '.', checks: ['service_no_wire'], max_findings: 3 },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.findings).toHaveLength(3);
            expect(result.data.truncated).toBe(true);
        }
    });

    it('summary counts are accurate', async () => {
        fixture('src/a.js', `
            const x = await supabase.from('ops_inventario').select('*');
            if (categoria === 'auto') { doIt(); }
        `);
        fixture('src/b.js', `
            const y = await supabase.from('ops_inventario').select('atributos');
        `);
        const result = await runAudit({ path: '.' }, workDir);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.summary.total).toBeGreaterThan(0);
            // 1 muro_de_fuego (error) + 1 zero_bifurcation (error) + 1 jsonb (info) = 3
            expect(result.data.summary.by_severity.error).toBeGreaterThanOrEqual(2);
            expect(result.data.summary.by_severity.info).toBeGreaterThanOrEqual(1);
        }
    });

    it('records which checks were run after filtering', async () => {
        fixture('src/x.js', 'export const x = 1;\n');
        const result = await runAudit(
            { path: '.', checks: ['muro_de_fuego', 'direct_auth_users'] },
            workDir
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.data.checks_run).toEqual(['muro_de_fuego', 'direct_auth_users']);
        }
    });
});

// ────────────────────────────────────────────────────────────
// auditorTool (MCP tool wrapper)
// ────────────────────────────────────────────────────────────

describe('mavis_auditor (MCP tool wrapper)', () => {
    it('is registered with name mavis_auditor', () => {
        expect(auditorTool.name).toBe('mavis_auditor');
        expect(auditorTool.description).toBeTruthy();
    });

    it('returns invalid_request for bad severity_threshold', async () => {
        const ctx: ToolContext = {
            workspace: createWorkspace(workDir),
            state: new State(workDir)
        };
        const result = await auditorTool.handler(
            { severity_threshold: 'critical' } as any,
            ctx
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.kind).toBe('invalid_request');
    });

    it('returns invalid_request for unknown check', async () => {
        const ctx: ToolContext = {
            workspace: createWorkspace(workDir),
            state: new State(workDir)
        };
        const result = await auditorTool.handler(
            { checks: ['made_up_check'] },
            ctx
        );
        expect(result.isError).toBe(true);
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.error.kind).toBe('invalid_request');
        expect(parsed.error.message).toContain('made_up_check');
    });

    it('returns ok with findings JSON when called on a real dir', async () => {
        fixture('src/bad.js', `
            const x = await supabase.from('ops_inventario').select('*');
        `);
        const ctx: ToolContext = {
            workspace: createWorkspace(workDir),
            state: new State(workDir)
        };
        const result = await auditorTool.handler(
            { path: '.', checks: ['muro_de_fuego'] },
            ctx
        );
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.ok).toBe(true);
        expect(parsed.data.findings).toHaveLength(1);
        expect(parsed.data.findings[0].kind).toBe('muro_de_fuego');
    });

    it('coerces max_findings via Number() (defense in depth)', async () => {
        fixture('src/clean.js', 'export const x = 1;\n');
        const ctx: ToolContext = {
            workspace: createWorkspace(workDir),
            state: new State(workDir)
        };
        // max_findings arrives as string from a non-strict JSON parser.
        const result = await auditorTool.handler(
            { path: '.', max_findings: '50' } as any,
            ctx
        );
        expect(result.isError).toBeFalsy();
        const parsed = JSON.parse(result.content[0]?.text as string);
        expect(parsed.ok).toBe(true);
        // max_findings was coerced to number 50 — no error.
    });
});
