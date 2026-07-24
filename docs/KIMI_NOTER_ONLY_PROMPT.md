# Kimi Code + Mavis MCP — Solo NotebookLM (mavis_noter)

> Prompt minimalista. Si solo necesitás que Kimi use el doctrinal notebook de KOMO OS vía `mavis_noter`, cargá este. Para el catálogo completo (14 tools), usá `docs/KIMI_K3_PROMPT.md`.

---

## Setup (una vez, en Kimi Code)

Settings → MCP Servers → Add:

```json
{
  "mcpServers": {
    "mavis": {
      "command": "node",
      "args": ["/Users/giovanni.cordon/Documents/mavis-mcp-server/dist/cli.js"],
      "env": {
        "MAVIS_WORKSPACE": "/Users/giovanni.cordon/Documents/komogt-main",
        "MINIMAX_BASE_URL": "https://api.minimax.io/v1",
        "MINIMAX_MODEL": "MiniMax-M3",
        "MINIMAX_API_KEY": "sk-cp-kpGNXVdG1vLwFQlgR5kK85nsRmbGmR0Mrp-z0K4Ln6B1ojHKhTyvNeX5TXqUs23uhne5vsPFEA4o0xNAxn_c4FGmyIDzVYpW-450FvZyIINQsyRCbi0XOes"
      }
    }
  }
}
```

Restart Kimi. Después de unos segundos debería listar 14 tools. La que necesitás es `mavis_noter`.

---

## Regla

**Para hacer una pregunta al doctrinal notebook de KOMO OS, SIEMPRE invocá `mavis_noter` con `action: "query"`.** No improvises respuestas de doctrina — el notebook es la fuente de verdad.

---

## Cómo invocar `mavis_noter`

**Input**:
```js
mavis_noter({
  action: "query",
  question: "¿Cuál es la doctrina sobre X?",
  // opcionales (usan defaults KOMO si se omiten):
  // notebook_id: "21102950-4bfc-4e4d-a78d-8e1a2b338d99"
  // conversation_id: "48cc26af-9f4d-4776-a6eb-b1bcb35d9179"
  // timeout_seconds: 60
})
```

**Output** (success):
```js
{
  ok: true,
  data: {
    answer: "El texto de la respuesta del notebook",
    conversation_id: "uuid",
    latency_ms: 3500
  }
}
```

**Output** (error):
```js
{
  ok: false,
  error: {
    kind: "config_error" | "auth_error" | "timeout" | "api_error",
    message: "human readable"
  }
}
```

**Defaults KOMO** (se aplican si no los pasás):
- `notebook_id`: `21102950-4bfc-4e4d-a78d-8e1a2b338d99` (KOMO doctrinal, 50+ sources)
- `conversation_id`: `48cc26af-9f4d-4776-a6eb-b1bcb35d9179` (mantiene contexto entre queries)

---

## Otras acciones disponibles

| action | Para qué |
|---|---|
| `query` | Preguntar al notebook. La que vas a usar 99% del tiempo. |
| `doctor` | Verificar que `nlm` CLI está autenticado y funciona. |
| `list_notebooks` | Listar todos los notebooks disponibles con id, título, source_count. |
| `add_source` | Agregar una URL o archivo como source al notebook. |
| `create_notebook` | Crear un notebook nuevo. |

---

## Patrones de uso

### Pregunta directa
```js
mavis_noter({
  action: "query",
  question: "¿Cuál es la doctrina KOMO sobre Zero-Bifurcation vertical?"
})
```

### Pregunta con follow-up (usa la conversation_id que devuelve)
```js
// Primera pregunta
const r1 = await mavis_noter({ action: "query", question: "¿Qué doctrinas load-bearing hay?" });
// Kimi extrae r1.data.conversation_id y la pasa en la siguiente
const r2 = await mavis_noter({
  action: "query",
  question: "¿Cómo se aplica Zero-Bifurcation en ops_inventario?",
  conversation_id: r1.data.conversation_id
});
```

### Antes de empezar un sprint grande
```js
// Verificá que nlm está OK
const doc = await mavis_noter({ action: "doctor" });
if (!doc.ok) {
  // Avisale al user: "NotebookLM no responde. Corré nlm doctor en tu terminal."
}

// Listá notebooks para saber qué hay disponible
const list = await mavis_noter({ action: "list_notebooks" });
console.log(list.data.notebooks);
```

### Después de un sprint, documentar decisiones
```js
// Agregar una nota al notebook (URL de un doc local, por ejemplo)
mavis_noter({
  action: "add_source",
  notebook_id: "21102950-...",  // KOMO doctrinal
  source: "/Users/giovanni.cordon/Documents/komogt-main/docs/sprints/sprint-XX.md"
})
```

---

## Errores y qué hacer

| Error | Causa | Acción |
|---|---|---|
| `config_error` | `nlm` CLI no instalado o no en PATH | Avisar al user: `pip install notebooklm-mcp-cli && nlm login` |
| `auth_error` | Cookies de Google expiraron | Avisar al user: `nlm login` |
| `timeout` | La query tardó más de `timeout_seconds` | Subir `timeout_seconds` (default 60) o reintentar |
| `api_error` | Network error | Reintentar una vez |

---

## Hard limits

- **No improvises doctrinas**: si Kimi no encuentra la respuesta en el notebook, decíselo al user. NO respondas con tupos conocimiento general sobre KOMO OS.
- **No agregues sources sin pedir**: `add_source` modifica el notebook. Solo invocá cuando el user lo pida explícitamente.
- **No cambies `notebook_id` o `conversation_id` defaults** a menos que el user lo pida (mantiene el contexto inter-queries).
