# Mavis MCP Server

> **Expose Mavis's coding tools (bash, edit, git, supabase) to Claude Code via MCP.**
> Let Claude reason. Mavis executes.

---

## What is this?

A **Model Context Protocol (MCP) server** that wraps the same tools Mavis uses internally
and exposes them as MCP tools. When connected to Claude Code, you get a workflow like:

```
┌──────────────────┐
│  Claude Code     │  ← you talk to Claude
│  (reasoning)     │  ← Claude plans, designs, decides
└────────┬─────────┘
         │ MCP protocol (stdio)
         ▼
┌──────────────────┐
│  Mavis MCP       │  ← thin wrapper
│   Server         │
└────────┬─────────┘
         │ spawns subprocesses
         ▼
┌──────────────────┐
│  bash, git,      │  ← actual execution
│  files, supabase │
└──────────────────┘
```

**Claude** thinks (planning, architecture, decisions).
**Mavis MCP** does (shell, file edits, git, supabase, tests, screenshots).

This is the same set of tools Mavis uses when running inside MiniMax Code.
The only difference is the interface: instead of a chat loop, Mavis's tools
are exposed as MCP tools for Claude.

## Why?

Mavis has battle-tested tools for:
- Reading/writing/editing files
- Running bash commands
- Git operations
- Supabase queries
- Running vitest
- Reading screenshots
- Grep / glob search

These are the same tools that make Mavis effective for the KOMO OS codebase.
Exposing them via MCP means **Claude gets the same operational power** without
re-implementing anything.

## Tools exposed

| Tool | Description |
|---|---|
| `mavis_bash` | Run a shell command in the workspace |
| `mavis_read` | Read a file (text or image) |
| `mavis_write` | Write/overwrite a file |
| `mavis_edit` | Edit a file (find/replace, single or all occurrences) |
| `mavis_search` | Grep across files (regex + glob). Uses ripgrep if available. |
| `mavis_git` | Git operations (status, diff, commit, push, log) |
| `mavis_supabase` | Supabase CLI queries (read-only, denylist for mutations) |
| `mavis_run_tests` | Run vitest with optional pattern |
| `mavis_state` | Get/save the MCP server's persistent state |

All tools accept an optional `cwd` to operate on a subdirectory.

## Quick start

### 1. Install + build

```bash
cd mavis-mcp-server
npm install
npm run build
```

### 2. Configure Claude Code

Add to your Claude Code MCP config (`~/.config/claude-code/mcp.json` or via the Claude Code UI):

```json
{
  "mcpServers": {
    "mavis": {
      "command": "node",
      "args": ["/absolute/path/to/mavis-mcp-server/dist/cli.js"],
      "env": {
        "MAVIS_WORKSPACE": "/absolute/path/to/your/project"
      }
    }
  }
}
```

For development (no build step):

```json
{
  "mcpServers": {
    "mavis": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mavis-mcp-server/src/cli.ts"],
      "env": {
        "MAVIS_WORKSPACE": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### 3. Restart Claude Code

The MCP server starts when Claude Code launches. Verify with `/mcp` in Claude Code.

### 4. Use from Claude Code

Once connected, Claude can call the tools:

```
You:  Find all HTTP 400 errors in the supabase logs and propose a fix.

Claude: [plans]
        [calls mavis_search, mavis_bash, mavis_read, mavis_edit, mavis_bash, mavis_run_tests, ...]
        [reports results]
```

The tools return text content (stdout, file content, etc.) and Claude reasons
about the next step.

## Architecture

### Workspace isolation

The MCP server operates within a **workspace directory** set via `MAVIS_WORKSPACE`.
All tool calls are scoped to that directory (or its subdirectories via `cwd`).

This means Claude can't accidentally `cd /` and `rm -rf` your home directory.
The workspace is a sandbox.

If you pass an absolute path that escapes the workspace, the tool returns
an error. Try: `mavis_read /etc/passwd` → "path escapes workspace".

### State

Persistent state lives at `<workspace>/.mavis/state.json`. It tracks:
- Recent files touched (deduped, capped at 50)
- Last 20 command exit codes
- Workspace metadata (created_at, last_used_at)

State is loaded at startup and saved after each tool call. If the file is
missing or corrupt, the server starts fresh.

### Security

- All bash commands run with the same privileges as the user
- The workspace boundary is a UX safeguard, not a security boundary
- For real sandboxing, run the MCP server in a container/VM

### Defense-in-depth per tool

Each tool has its own safety:
- `mavis_bash`: no command whitelist; rely on workspace + user trust
- `mavis_edit`: refuses multi-replace unless `all_occurrences=true` (prevents accidents)
- `mavis_supabase`: denylist of dangerous subcommands (`db push`, `db reset`, `db execute`)
- `mavis_run_tests`: respects workspace; no side effects outside

## Examples

### Example 1: Fix a bug

```
You: Fix the off-by-one error in calculateTotal() in src/billing.ts.
     Add a regression test and run the suite.

Claude:
  1. mavis_read src/billing.ts
  2. mavis_search pattern="calculateTotal" glob="*.ts" cwd=src
  3. mavis_read tests/billing.test.ts
  4. mavis_edit old_text="i <= arr.length" new_text="i < arr.length"
  5. mavis_write tests/billing-total.test.ts
  6. mavis_run_tests pattern="tests/billing-total.test.ts"
  7. mavis_bash command="git add -A && git commit -m 'fix: off-by-one in calculateTotal'"
```

### Example 2: Investigate a Supabase error

```
You: Why are we getting 400s when creating deals?

Claude:
  1. mavis_search pattern="400|invalid" cwd=supabase/functions/komo-deal-engine
  2. mavis_read supabase/functions/komo-deal-engine/_handler.ts
  3. mavis_supabase args=["db", "query", "--linked", "SELECT ... FROM ops_deals WHERE ..."]
  4. mavis_edit old_text="..." new_text="..." (fix)
  5. mavis_run_tests pattern="tests/wire/sprint28"
```

### Example 3: Commit a feature

```
You: Commit the changes from sprint 29 with a clean message.

Claude:
  1. mavis_git args=["status"]
  2. mavis_git args=["diff", "--stat"]
  3. mavis_git args=["log", "-3", "--oneline"]  (for message style)
  4. mavis_git args=["add", "."]
  5. mavis_git args=["commit", "-m", "feat(sprint-29): ..."]  (Claude writes the message)
  6. mavis_git args=["push", "origin", "main"]
```

## Development

### Project structure

```
mavis-mcp-server/
├── src/
│   ├── cli.ts          # Entry point: parses args, loads workspace, starts server
│   ├── server.ts       # MCP server: registers tools, dispatches calls
│   ├── workspace.ts    # Workspace isolation (sandbox root)
│   ├── state.ts        # Persistent per-workspace state
│   └── tools/
│       ├── index.ts    # Tool registry (re-exports individual tools)
│       ├── types.ts    # ToolDef + ToolContext interfaces
│       ├── bash.ts
│       ├── read.ts
│       ├── write.ts
│       ├── edit.ts
│       ├── search.ts
│       ├── git.ts
│       ├── supabase.ts
│       ├── run_tests.ts
│       └── state.ts
├── tests/              # Vitest tests
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

### Run tests

```bash
npm test
```

### Watch mode

```bash
npm run test:watch
```

### Build

```bash
npm run build
```

### Dev mode (no build)

```bash
npm run dev
```

## Status

**DONE** — initial sprint:
- [x] Project setup (package.json, tsconfig, vitest)
- [x] MCP server skeleton (stdio + tool registration)
- [x] 9 tools implemented
- [x] State management (.mavis/state.json)
- [x] 60 tests (workspace, state, 9 tools, server integration)
- [x] README with Claude Code config + examples

## Roadmap

- [ ] Streaming responses for long-running tools (bash, run_tests)
- [ ] Tool result caching (avoid re-running the same query)
- [ ] More tools: `mavis_image_read` (vision), `mavis_lsp` (type info)
- [ ] Multi-workspace support (one server, many projects)
- [ ] OAuth / API key auth for remote Claude Code
- [ ] WebSocket transport (instead of stdio only)

## Why "Mavis"?

This server's name is **Mavis** (Model-context-protocol Agent for Versatile
Implementation & Support). It's the same agentic loop Mavis uses internally,
exposed as MCP.

## License

MIT
