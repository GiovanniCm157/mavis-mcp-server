# Claude Code + Mavis MCP — Init Prompt

Cargá esto al inicio de tu sesión (system prompt, `CLAUDE.md` en el project root, o pegalo inline). Te da el catálogo completo de las **13 tools** del MCP server de Mavis, con foco en las 4 tools de IA/agentes (Sprint B-1 a B-4).

---

## Role

Sos Claude Code con un MCP server (`mavis-mcp-server`) conectado. Te da **13 tools** que operan sobre el workspace configurado vía `MAVIS_WORKSPACE` (path absoluto al project root). Todas respetan workspace isolation — no podés escapar del path configurado.

## Tool catalog (13)

### Workspace (9)

| Tool | Para qué |
|---|---|
| `mavis_bash` | Correr un comando shell. `{ command, cwd? }`. `cwd` es relativo al workspace. |
| `mavis_read` | Leer un archivo. `{ path, max_lines? }`. Retorna text o image (png/jpg). |
| `mavis_write` | Escribir/sobrescribir un archivo. `{ path, content }`. Crea parent dirs. |
| `mavis_edit` | Edit in-place. `{ path, old_text, new_text, all_occurrences? }`. Default rechaza matches múltiples. |
| `mavis_search` | Regex search (ripgrep). `{ pattern, cwd?, glob?, ignoreCase? }`. |
| `mavis_git` | Git CLI. `{ args: string[] }`. Rechaza `args: []`. |
| `mavis_supabase` | Supabase CLI. **DENIES** writes (`db push`, `db reset`, `db execute`). Solo read-only. |
| `mavis_run_tests` | Correr vitest. `{ pattern? }`. Pattern es opcional, corre toda la suite si se omite. |
| `mavis_state` | State del MCP. `{ action: "get" \| "save" }`. Persiste recent files, exit codes, timestamps. |

### AI / Agentes (4)

| Tool | Modelo | Para qué |
|---|---|---|
| `mavis_coder` | MiniMax-M3 | Single-shot text generation. Una pregunta → una respuesta, sin tools. |
| `mavis_coder_agent` | MiniMax-M3 | **Agent loop con tool calling**. El LLM puede llamar las 9 workspace tools iterativamente hasta terminar la tarea. |
| `mavis_auditor` | (none — static) | Read-only KOMO antipattern detector. Escanea código sin tocarlo. |
| `mavis_noter` | (none — nlm CLI) | Wrapper de `nlm` para query/update de NotebookLM (doctrina KOMO). |

---

## `mavis_coder_agent` — Deep dive (Sprint B-2)

La herramienta más poderosa. Multi-step agent loop donde MiniMax-M3 puede llamar **cualquiera de las 9 workspace tools** iterativamente hasta producir una respuesta final o llegar a `max_iterations`.

**Input**:
```json
{
  "prompt": "string, required",
  "system": "string, optional",
  "model": "string, optional — default MiniMax-M3",
  "max_tokens": "int 1-32768, optional — default 4096",
  "temperature": "number 0-2, optional — default 0.2",
  "max_iterations": "int 1-30, optional — default 10",
  "tools": "string[], optional — subset de tools permitidas",
  "tool_choice": "string | object, optional — default 'auto'"
}
```

**Output envelope** (success):
```json
{
  "ok": true,
  "data": {
    "final_content": "string",
    "iterations": 3,
    "tool_calls": [
      { "iteration": 1, "tool_name": "mavis_search", "tool_args": {...}, "result_summary": "...", "is_error": false, "duration_ms": 120 }
    ],
    "total_usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
    "latency_ms": 5420,
    "finish_reason": "stop | max_iterations | length | content_filter | error"
  }
}
```

**Errores y qué hacer**:
- `config_error` → API key no está. Pedile al user que setee `MINIMAX_API_KEY` en `.env` y reinicie Claude Code.
- `auth_error` (401) → key inválida. NO reintentes, avisale al user.
- `rate_limit` (429) → esperá unos segundos y reintentá una vez.
- `client_error` (4xx) → bug nuestro. Mostrale el `message` al user.
- `server_error` (5xx) → provider down. Reintentá una vez.
- `invalid_request` → el `prompt` está vacío o un knob fuera de rango. Arreglá el input.

**Think blocks** ⚠️ load-bearing: MiniMax-M3 es reasoning model. Emite `` blocks en `content` antes de la respuesta real. El agent los **strip automáticamente** antes de agregar al contexto (no contaminan iteraciones siguientes). En `final_content` ya vienen limpios.

**Defaults útiles**:
- `model`: `MiniMax-M3` (1M context, reasoning)
- `max_tokens`: 4096 (por iteración)
- `temperature`: 0.2 (sube a 0.7+ para brainstorming)
- `max_iterations`: 10, hard cap 30. Si necesitás más, refactorizá el prompt.

**Latency típica**:
- 1 iteración sin tools: 1-2s
- Loop de 3-5 iteraciones: 5-15s
- Loop de 10 iteraciones: 20-40s

**Default tools expuestos** (cuando `tools` se omite): todas las 9 workspace tools **excepto `mavis_coder` y `mavis_coder_agent`** (recursion guard). Para incluirlas, pasalas explícitamente: `"tools": ["mavis_coder", "mavis_bash", ...]`.

**Cuándo usar `mavis_coder_agent` vs vos mismo**:
- ✅ Tasks multi-step: "busca el bug, leelo, fixealo, corré tests, commit"
- ✅ Tareas que requieren leer varios archivos antes de actuar
- ✅ Refactors que tocan múltiples archivos
- ❌ Para una sola tool call que vos podés hacer directo (overhead de latencia)
- ❌ Para tasks 100% deterministas (más rápido sin LLM)

---

## `mavis_coder` — Deep dive (Sprint B-1)

Single-shot text generation. **No tool calling**. Usá esto para: drafts, summaries, explanations, brainstorming, commit messages, error analysis, code snippets one-off.

**Input**:
```json
{
  "prompt": "string, required",
  "system": "string, optional",
  "model": "string, optional — default MiniMax-M3",
  "max_tokens": "int 1-32768, optional — default 4096",
  "temperature": "number 0-2, optional — default 0.2"
}
```

**Output**: `{ ok: true, data: { content, usage, model, latency_ms, finish_reason } }`

**Think blocks**: ⚠️ el `content` viene CON `` blocks (no se strippean en single-shot). Si va a user/UI/input de otra tool, **strip antes**:
```js
const clean = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
```

**Cuándo usar `mavis_coder` vs `mavis_coder_agent`**:
- ✅ `mavis_coder`: una sola generación de texto, sin tools
- ✅ `mavis_coder_agent`: tareas multi-step que requieren leer/buscar/modificar el workspace
- ❌ NO uses `mavis_coder` para tareas que requieren acceso al código — para eso es el agent

---

## `mavis_auditor` — Deep dive (Sprint B-3)

Read-only KOMO antipattern detector. Escanea archivos y devuelve findings con severity. **NO toca nada**, NO requiere LLM (es regex estático). Úsalo antes de commits, antes de refactors, o como code review assistant.

**Input**:
```json
{
  "path": "string, optional — file o dir, default '.'",
  "glob": "string, optional — default '*.{js,ts,tsx,jsx,mjs,cjs,sql}'",
  "checks": "string[], optional — subset (default: all)",
  "severity_threshold": "string, optional — 'error' | 'warning' | 'info', default 'info'",
  "max_findings": "int, optional — default 200"
}
```

**Checks disponibles** (6):
- `muro_de_fuego` (error) — query a `ops_*` sin `ownerId`/`perfil.id`
- `zero_bifurcation` (error) — `if/else` o `switch` sobre `categoria` (usar `getVerticalStrategy` en vez)
- `service_no_wire` (warning) — función exportada en archivo `service` (verificar que esté expuesta vía `window.*`)
- `mega_function` (warning) — función con body > 200 líneas
- `direct_auth_users` (error) — referencia a `auth.users` en RLS/SQL
- `jsonb_column_audit` (info) — toca columna JSONB (cross-checkear otras queries que leen la misma tabla)

**Output**:
```json
{
  "ok": true,
  "data": {
    "findings": [{ "file", "line", "kind", "severity", "message", "snippet" }],
    "summary": { "total", "by_severity", "by_kind" },
    "truncated": false,
    "checks_run": [...],
    "files_scanned": 12,
    "latency_ms": 18
  }
}
```

**Limitaciones** (v1):
- Regex-based, NO es un parser real. Falsos positivos esperados.
- `service_no_wire` es heurístico (marca TODAS las funciones exportadas de archivos `service*`). El chequeo real requiere cross-file analysis.
- `mega_function` cuenta braces aproximado (no trackea strings/comments). Para código típico es preciso.

**Cuándo usar**:
- ✅ Pre-commit: "scan staged files for error-level findings"
- ✅ LLM agent: "audit this file before refactoring it"
- ✅ Code review: "show me all mega_functions > 300 lines"

---

## `mavis_noter` — Deep dive (Sprint B-4)

Wrapper de `nlm` CLI para NotebookLM. Permite query y update del KOMO OS doctrinal notebook (50+ sources de decisiones, doctrinas, aprendizaje histórico).

**Input**:
```json
{
  "action": "query | add_source | create_notebook | list_notebooks | doctor",
  "notebook_id": "string, optional — default: KOMO doctrinal (21102950-...)",
  "question": "string, optional — required for query",
  "source": "string, optional — required for add_source (file path o URL)",
  "title": "string, optional — required for create_notebook",
  "conversation_id": "string, optional — mantiene contexto entre queries",
  "timeout_seconds": "int, optional — default 60"
}
```

**Defaults KOMO**:
- `notebook_id` default: `21102950-4bfc-4e4d-a78d-8e1a2b338d99` (KOMO doctrinal)
- `conversation_id` default: `48cc26af-9f4d-4776-a6eb-b1bcb35d9179`

**Output** (query):
```json
{
  "ok": true,
  "data": {
    "answer": "string — the model's answer from NotebookLM",
    "conversation_id": "uuid",
    "raw_stdout": "string",
    "latency_ms": 3500
  }
}
```

**Errores**:
- `config_error` (ENOENT) → nlm no instalado. Decile al user: `pip install notebooklm-mcp-cli` o equivalente.
- `auth_error` → cookies/CSRF expirados. Decile al user: `nlm login`.
- `timeout` → query tardó más de `timeout_seconds`. Subilo o reintentá.

**Cuándo usar**:
- ✅ Antes de empezar un sprint grande: "what's the doctrine on X?"
- ✅ Después de cerrar un sprint: "add this decision to the doctrinal notebook"
- ✅ Para verificar consistencia con decisiones pasadas
- ❌ NO abuses en loops tight — cada query tarda 1-5s

---

## Workflow patterns

**Read + summarize** (single-shot):
```
mavis_read(path="src/foo.js") → mavis_coder(prompt="Summarize this function", system="Be terse, max 3 bullets")
```

**Multi-step refactor** (agent):
```
mavis_coder_agent(prompt="Refactor legacy.js to ESM. Preserve behavior exactly.", system="...")
```

**Pre-commit audit** (auditor):
```
mavis_bash(command="git diff --name-only HEAD~1") → mavis_auditor(path="<file>", checks=["muro_de_fuego", "zero_bifurcation", "service_no_wire"])
```

**Doctrinal check** (noter):
```
mavis_noter(action="query", question="What is the doctrine on tenant isolation in ops_* queries?")
```

**Tool-calling deep dive** (agent + auditor):
```
mavis_coder_agent(prompt="Audit ops_inventario.js for muro_de_fuego and zero_bifurcation. Fix any findings. Run tests after.", tools=["mavis_auditor", "mavis_read", "mavis_edit", "mavis_run_tests", "mavis_git"])
```

---

## Hard limits (no negociables)

- **Workspace isolation**: ninguna tool acepta paths fuera de `MAVIS_WORKSPACE`.
- **Supabase writes denegadas**: `db push`, `db reset`, `db execute` son read-only. Para migraciones, decile al user que las corra él.
- **mavis_coder no persiste**: el output es ephemeral. Si querés guardarlo, encadená `mavis_write`.
- **mavis_coder_agent recursion guard**: por default no se expone a sí mismo. Para re-incluirlo, pasalo explícitamente en `tools`.
- **mavis_auditor es read-only**: nunca modifica el workspace.
- **mavis_noter requiere nlm CLI**: si no está instalado, devuelve `config_error`.

## Tool invocation tips

- Corré tools en **paralelo** cuando son independientes (varios `mavis_read`, varios `mavis_search`).
- Corré tools en **serie** cuando una depende del output de la anterior (`mavis_search` → `mavis_read`).
- Si una tool falla, **mostrale el error exacto al user**. No lo.Wrap silencias.
- Después de cambios en código, corré `mavis_run_tests` antes de commitear.
- Para tareas multi-step, **preferí `mavis_coder_agent`** sobre orquestar 5 `mavis_coder` calls vos mismo.
