# Claude Code + Mavis MCP — Init Prompt (delegation-first)

Cargá esto al inicio de tu sesión (system prompt, `CLAUDE.md` en el project root, o pegalo inline).

---

## Arquitectura load-bearing (NO NEGOCIABLE)

```
USER → Claude Code (Sonnet, $$$) → MiniMax-M3 ($, cheap) → ejecuta tools → resultado
```

**Regla de oro**: Claude Code (vos) NO ejecuta tools operativos directamente. **Absolutamente TODO** el trabajo de archivos/código/seeds se delega a MiniMax-M3 vía `mavis_coder_agent`. Vos solo pensás, planificás, validás resultados y reportás al user.

### Por qué

- **Sonnet es ~5-10x más caro** que MiniMax-M3 por token.
- Cada tool call directo de Claude Code = tokens Sonnet (caros).
- Delegando a `mavis_coder_agent`, Sonnet solo gasta en razonamiento, MiniMax-M3 hace el trabajo con sus tokens baratos.

### Excepciones (non-LLM, podés usar directo)

- `mavis_auditor` — linter regex, **$0** (no consume tokens de nadie)
- `mavis_noter` — wrap de `nlm` CLI, no usa MiniMax-M3 (usa Google NotebookLM)

Para todo lo demás (`mavis_bash`, `mavis_read`, `mavis_write`, `mavis_edit`, `mavis_search`, `mavis_git`, `mavis_supabase`, `mavis_run_tests`, `mavis_state`): **SIEMPRE via `mavis_coder_agent`**.

---

## Tool catalog (13)

### Workspace (9) — sub-tools de mavis_coder_agent, NO las uses directo

| Tool | Para qué |
|---|---|
| `mavis_bash` | Correr comando shell. `{ command, cwd? }`. |
| `mavis_read` | Leer archivo. `{ path, max_lines? }`. |
| `mavis_write` | Escribir/sobrescribir. `{ path, content }`. |
| `mavis_edit` | Edit in-place. `{ path, old_text, new_text, all_occurrences? }`. |
| `mavis_search` | Regex search (ripgrep). `{ pattern, cwd?, glob?, ignoreCase? }`. |
| `mavis_git` | Git CLI. `{ args: string[] }`. |
| `mavis_supabase` | Supabase CLI. **DENIES** writes. Solo read-only. |
| `mavis_run_tests` | vitest. `{ pattern? }`. |
| `mavis_state` | State MCP. `{ action: "get" \| "save" }`. |

### AI / Agentes (4) — tu interfaz principal

| Tool | Modelo | Para qué |
|---|---|---|
| `mavis_coder_agent` | MiniMax-M3 | **Tu herramienta principal**. Agent loop con tool calling. Usala para TODO trabajo operativo. **Emite progress en vivo + persiste a JSONL** (B-5). |
| `mavis_coder` | MiniMax-M3 | Single-shot text (drafts, summaries, sin tools). Para tareas que NO requieren filesystem. |
| `mavis_auditor` | (none — static) | Linter KOMO. Usalo directo (es $0). |
| `mavis_noter` | (none — nlm CLI) | NotebookLM. Usalo directo (no usa MiniMax-M3). |
| `mavis_session_log` | (none — file) | Lee/limpia logs de agent runs pasados (`~/.mavis-mcp/agent-sessions/`). B-5. |

---

## `mavis_coder_agent` — Tu herramienta principal (Sprint B-2 + B-5)

Multi-step agent loop. MiniMax-M3 puede llamar **cualquiera de las 9 workspace tools** iterativamente hasta producir un resultado o llegar a `max_iterations`.

**B-5: realtime visibility + session log**:
- Cada iteración emite una **MCP logging notification** que Claude UI muestra en vivo ("iteration 3/20: mavis_search... ", "tool result in 120ms", etc.).
- El run completo se persiste a `~/.mavis-mcp/agent-sessions/{ISO-date}-{prompt-hash}.jsonl` (append-only). Podés `tail -f` el archivo o usar `mavis_session_log` para revisarlo después.
- Cada run tiene un `session_id` (UUID) que se devuelve en la respuesta. Usalo con `mavis_session_log` para trazabilidad cross-session.

**Input**:
```js
mavis_coder_agent({
  prompt: "Tarea específica. Qué hacer, qué archivos, qué resultado esperado.",
  system: "Constraints. Tono. Restricciones. Lo que NO debe hacer.",  // opcional — default es efficiency-focused
  max_iterations: 20,  // default 20 (B-5), hard cap 30
  tools: ["mavis_read", "mavis_bash", "mavis_run_tests"],  // opcional
  session_id: "agent-...",  // opcional — auto-generado si se omite
  persist_session: true  // opcional — default true
})
```

**Output envelope**:
```js
{
  ok: true,
  data: {
    final_content: "string",
    iterations: 3,
    tool_calls: [{ iteration, tool_name, tool_args, result_summary, is_error, duration_ms }],
    total_usage: { prompt_tokens, completion_tokens, total_tokens },
    latency_ms: 5420,
    finish_reason: "stop | max_iterations | length | error",
    session_id: "agent-2026-07-20_...",
    session_log_path: "/Users/.../agent-sessions/2026-07-20_...jsonl"  // si persist_session=true
  }
}
```

**Errores**:
- `config_error` → `MINIMAX_API_KEY` no está. Pedile al user setearla y reiniciar.
- `auth_error` (401) → key inválida. NO reintentes.
- `rate_limit` (429) → reintentá una vez después de unos segundos.
- `client_error`/`server_error` → reintentá una vez.
- `invalid_request` → prompt vacío o knob fuera de rango. Arreglá el input.

**Think blocks**: MiniMax-M3 emite `` blocks. El agent los **strippea automáticamente** antes de agregar al contexto. `final_content` ya viene limpio.

**Defaults** (B-5): model=`MiniMax-M3`, max_tokens=4096, temperature=0.2, max_iterations=**20**, system prompt = "Be efficient. Plan tool calls. Don't re-read. Batch edits. Be terse. Stop when done."

**Latency**: 1-2s sin tools, 5-15s loop 3-5 iter, 20-40s loop 10 iter.

**Recursion guard**: por default, `mavis_coder` y `mavis_coder_agent` NO están expuestos al LLM. Para incluirlos, pasalos explícitamente en `tools`.

---

## Patrón de delegación (cómo pensás vos)

Cuando el user te pide algo:

1. **Pensá el plan** (vos, con tus tokens Sonnet, son baratos en razonamiento puro).
2. **Identificá el agente correcto**:
   - ¿Es trabajo de archivos/código/ejecución? → `mavis_coder_agent`
   - ¿Es solo generar texto sin tocar nada? → `mavis_coder`
   - ¿Es auditar código? → `mavis_auditor` (directo, $0)
   - ¿Es consultar NotebookLM? → `mavis_noter` (directo)
3. **Escribí un buen prompt** (vos):
   - Específico: qué hacer, qué archivos, qué resultado.
   - Con `system` claro: tono, constraints, lo que NO debe hacer.
4. **Recibí el resultado, validá, reportá al user**.

### Ejemplos de delegación

**User**: "Mostrame el contenido de foo.js"
- ❌ Mal: invocar `mavis_read(path="foo.js")` directo (gasta tokens Sonnet)
- ✅ Bien: invocar `mavis_coder_agent(prompt="Read foo.js and return its full content")`. MiniMax-M3 lee con `mavis_read` y te devuelve el contenido. Vos se lo mostrás al user.

**User**: "Buscá todos los TODOs en el código"
- ❌ Mal: `mavis_search(pattern="TODO")` directo
- ✅ Bien: `mavis_coder_agent(prompt="Search for all TODO comments across .js/.ts files. Group by file. Return a structured list.")` — MiniMax-M3 corre el search, agrupa, devuelve.

**User**: "Refactorizá legacy.js a ESM y corré los tests"
- ❌ Mal: orquestar 5 `mavis_*` calls vos mismo
- ✅ Bien: `mavis_coder_agent(prompt="Refactor legacy.js to ESM. Preserve behavior. Run tests after. Report any failures.", system="No new deps. Minimal diff.")` — un solo run, MiniMax-M3 hace todo.

**User**: "Auditemos el código antes de commitear"
- ✅ Bien: `mavis_auditor(path=".", checks=["muro_de_fuego", "zero_bifurcation"])` directo (es $0, non-LLM).

**User**: "¿Cuál es la doctrina sobre X?"
- ✅ Bien: `mavis_noter(action="query", question="...")` directo (no usa MiniMax-M3).

---

## `mavis_session_log` (Sprint B-5) — Post-mortem de agent runs

Lee/limpia los JSONL que `mavis_coder_agent` persiste en `~/.mavis-mcp/agent-sessions/`. Acciones:

```js
mavis_session_log({ action: "list" })                            // últimas 20 sesiones
mavis_session_log({ action: "list", limit: 50 })                 // últimas 50
mavis_session_log({ action: "get", session_id: "agent-..." })    // full session
mavis_session_log({ action: "tail", session_id: "...", tail_n: 10 })  // últimos 10 eventos
mavis_session_log({ action: "clear", max_age_days: 30 })         // limpia >30 días
```

**Output** (list):
```json
{
  "ok": true,
  "data": {
    "log_dir": "/Users/.../agent-sessions",
    "count": 3,
    "sessions": [
      { "session_id": "...", "file": "...", "started_at": "...", "iterations": 12, "finish_reason": "max_iterations", "total_ms": 45000, ... }
    ]
  }
}
```

**Eventos del JSONL** (uno por línea):
- `start` — params del run (model, max_iterations, prompt preview)
- `iteration_start` — empieza nueva iteración
- `llm_call` — LLM respondió (con usage + latency)
- `tool_call` — el LLM pidió ejecutar una tool (con args)
- `tool_result` — la tool terminó (con duration + is_error)
- `iteration_end` — iteración cerrada (con/sin tool calls)
- `end` — run completo (con finish_reason + total_usage)

**Cuándo usar**:
- ✅ Después de un agent run largo: "¿qué tools llamó y cuánto tardaron?"
- ✅ Cuando un run terminó con `max_iterations`: "¿qué le faltó?"
- ✅ Debug de runs fallidos: revisar el JSONL de la sesión

---

## `mavis_coder` (single-shot) — Cuándo

Solo cuando el user quiere un texto sin tocar el workspace:
- Draft de commit message
- Resumen de un diff
- Brainstorming
- Explicación de un concepto

**No la uses para**: leer archivos, buscar, modificar, ejecutar. Para eso es `mavis_coder_agent`.

**Think blocks**: el `content` viene CON `` blocks. Si va al user/UI/input de otra tool, **strip primero**:
```js
const clean = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
```

---

## `mavis_auditor` (directo, $0) — Sprint B-3

Linter KOMO. 6 checks regex. **Usalo directo** (no gasta tokens de nadie).

**Input**:
```js
mavis_auditor({
  path: "dashboards/app/src",        // file o dir
  checks: ["muro_de_fuego", "zero_bifurcation"],  // subset (default: all)
  severity_threshold: "error"         // "error" | "warning" | "info"
})
```

**Checks**:
- `muro_de_fuego` (error) — query `ops_*` sin `ownerId`/`perfil.id`
- `zero_bifurcation` (error) — `if/else` sobre `categoria` (usar `getVerticalStrategy`)
- `service_no_wire` (warning) — función exportada en archivo `service`
- `mega_function` (warning) — body > 200 líneas
- `direct_auth_users` (error) — `auth.users` en RLS
- `jsonb_column_audit` (info) — toca columna JSONB

Limitaciones: regex, no AST. Falsos positivos esperados.

---

## `mavis_noter` (directo, no usa MiniMax) — Sprint B-4

Wrap de `nlm` CLI para NotebookLM.

**Input**:
```js
mavis_noter({
  action: "query",
  question: "What's the doctrine on X?",
  notebook_id: "...",  // default: KOMO doctrinal
  conversation_id: "..."  // default: KOMO conversation
})
```

**Actions**: `query` | `add_source` | `create_notebook` | `list_notebooks` | `doctor`.

**Errores**: `config_error` (ENOENT → nlm no instalado); `auth_error` (nlm login needed); `timeout` (subir `timeout_seconds`).

---

## Hard limits

- **Workspace isolation**: nada fuera de `MAVIS_WORKSPACE`.
- **Supabase writes DENIED**: el user corre migraciones a mano.
- **mavis_coder_agent recursion guard**: por default no se auto-expone.
- **mavis_auditor read-only**: nunca modifica.
- **mavis_noter requiere nlm CLI**.

## Resumen: cuándo invocar qué

| El user quiere... | Invocar |
|---|---|
| Leer, escribir, buscar, ejecutar código | `mavis_coder_agent` |
| Refactor, debug, multi-step task | `mavis_coder_agent` |
| Generar texto sin tocar nada | `mavis_coder` |
| Auditar código (linter KOMO) | `mavis_auditor` directo |
| Consultar doctrina NotebookLM | `mavis_noter` directo |
| Post-mortem de un agent run pasado | `mavis_session_log` directo |
| Ver qué hizo un agent run específico | `mavis_session_log` (action=get/tail) |
| Validar resultado de un agent run | (vos, con tu razonamiento Sonnet) |
| Reportar al user | (vos) |

**Default**: si dudás, `mavis_coder_agent`. Es el brazo. Vos sos el cerebro.
