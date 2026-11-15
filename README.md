# Cortex v5

**Cortex** is a local-first Knowledge Operating System: an Obsidian-like knowledge editor with a linked project memory and context-aware AI that works from the same memory.

## Core capabilities
### Knowledge editor
- Markdown vault (notes, PRD/Spec/RFC/ADR docs, decisions, meetings, procedures)
- hierarchical sidebar (projects → docs/decisions/tasks/meetings/notes)
- split editor/preview with real markdown lists and task checkboxes
- linked context per document: related tasks (with `@owner` and `due:`), related notes, backlinks, history snapshots
- ⌘K quick switcher: notes + commands + semantic results

### Project memory (Layer 2/3)
- SQLite structured mirror (`data/cortex.db`, all queries parameterized) synced from the vault
- task model with owner and due dates, project scope
- project health timeline (`/api/health/history`)
- persistent hybrid retrieval index (lexical + embeddings + MMR rerank)

### Actionable AI
- grounded summarization with completeness critique (`/api/ai/summarize`)
- meeting notes → executable action items with owners/dates (`/api/ai/meeting-actions`, apply with `/api/ai/apply-actions`)
- cross-document contradiction detection with sources (`/api/ai/contradictions`)
- answers from project context with source chips — never general knowledge
- deterministic fallbacks in mock mode; works with Ollama or any OpenAI-compatible endpoint

### Runtime layer
- MCP memory server over stdio (28 tools) for external runtimes (`mcp-memory-server.js`)
- designed for Claude Code / OpenCode / DeepSeek Harness / generic MCP runtimes
- SSE live sync: external vault edits refresh the UI without reloading

### Memory layer
- local Markdown vault under `vault/`
- structured frontmatter overlays
- note history snapshots in `data/history/`
- backups in `data/backups/`

### Reasoning layer
- note classification
- structured extraction: tasks, decisions, risks, questions
- contradiction detection
- gap detection
- health score

### Agent layer
- session-based agent workflow
- next-best-action engine
- living note generation
- project-state synthesis
- critic / builder / memory / project modes

## Run
Requires **Node.js ≥ 22.5** — Cortex uses the built-in `node:sqlite` module and
installs no runtime dependencies.

```bash
npm start          # خادم محلي على http://127.0.0.1:3737
npm run desktop    # نافذة تطبيق مستقلة (Edge/Chrome app mode)
```
Open `http://127.0.0.1:3737`

Environment:
- `APP_PORT` — port (default `3737`)
- `APP_HOST` — bind address (default `127.0.0.1`; refused on a network interface without `CORTEX_ALLOW_REMOTE=1`)
- `APP_ROOT` — vault/data root outside the project folder
- `APP_MAX_BODY_BYTES` — request body cap (default 2 MB, returns 413)
- `APP_MODEL_TIMEOUT_MS` / `APP_MODELS_TIMEOUT_MS` — outbound model / model-list timeouts
- `CORTEX_VAULT_DIR` — use an existing Obsidian vault in place (no copy, no rename)
- `CORTEX_GATES_MAX_AGE_MS` — release-gate freshness window (default 1 hour)
- `CORTEX_ALLOWED_ROOTS` — explicit extra roots for file tools (path-delimited)

Notes:
- **No external dependencies and no `npm install` needed.**
- Backups are written as real ZIP files by a built-in writer — no `zip` binary required.
- CORS is pinned to the exact same origin; the API is not reachable from external web pages.
- The UI follows external vault edits live over SSE (`/api/watch`) without reloading the page.
- The retrieval index is **not** rebuilt automatically while the server runs (a full rebuild
  blocks the event loop). Run `node tools/rebuild-index.cjs` on a schedule, or press
  "rebuild index" in Settings. Search serves from the current index and reports `indexStale`.

## Scope — read this before deploying
Cortex is a **single-user, local-first** tool:

| Supported | Not supported |
|---|---|
| One person, one machine, `127.0.0.1` | Teams, multi-user, shared vaults |
| Markdown you own and can open anywhere | HTTPS, SSO, tenant isolation |
| Local lexical retrieval (n-gram TF-IDF) | Neural/dense semantic search |
| 28 MCP tools for external agents | Cloud sync |

See [SECURITY.md](SECURITY.md) for the threat model and its stated limits.

## Test
```bash
npm test
```

## Security
Cortex is local-first: it binds `127.0.0.1` by default, requires a session token for
writes, encrypts provider keys at rest, and refuses to start on a network interface
unless you explicitly opt in. Read [SECURITY.md](SECURITY.md) before exposing it.

## Connecting other agents (MCP)

Two transports, both served from the same tool surface (`cortex-mcp-core.js`):

- **stdio** — run `node mcp-memory-server.js --root <app-root>`. Process-level trust,
  no token; best for local clients that spawn the server themselves.
- **HTTP** — `POST http://127.0.0.1:3737/mcp` with
  `Authorization: Bearer <MCP token>`. The token lives in `data/mcp.token` (mode
  `0600`) and is **shown inside the config block** in the MCP panel, so copying it is
  one click. Requests without it get `401` — the endpoint no longer accepts anonymous
  writes.

`GET /api/mcp-info` returns the tool list and the ready-to-paste HTTP config; it is
session-protected because it contains the token. You can stop incoming HTTP traffic
entirely from the MCP panel (`mcp.incomingEnabled = false`).

## Main endpoints
- `GET /api/status`
- `GET /api/ping` — cheap liveness probe (watchdog)
- `GET /api/notes`
- `POST /api/notes`
- `POST /api/ai/chat` — `{stream:true}` for SSE token streaming
- `GET /api/review/:id`
- `GET /api/note-history/:id` — list snapshots
- `GET /api/note-history/:id/:file` — read one snapshot
- `GET /api/project-state?project=...`
- `POST /api/project-state/living-note`
- `POST /api/agent/session/start`
- `POST /api/agent/next-action`
- `POST /api/models/use-provider` — activate a saved provider server-side
- `POST /api/backup`
- `GET /api/mcp-info`

## Backup, restore, and the retrieval index

**Backup.** `POST /api/backup` (or the button in Settings) writes a real ZIP into
`data/backups/` — built by an in-repo writer, no `zip` binary needed. It contains
`vault/` (Markdown = the source of truth), the SQLite database, settings, history,
sessions, and `data/assets/` (the original bytes of imported documents).
The `backup_restorable` gate verifies a backup by opening the DB **and** counting
`vault/*.md` inside the ZIP — a backup without your notes fails the gate.

**Restore.** There is no one-click restore; recovery is deliberate:

1. Stop the server.
2. Unzip the chosen backup over a **copy** of the project folder (never over the
   live one).
3. Start the server on the copy with `APP_ROOT=<copy>` and verify the notes list
   and a few documents before replacing anything.

**Retrieval index.** `data/vector-index.json` is derived, never a source of
truth: it can always be rebuilt from the vault.

```bash
node tools/rebuild-index.cjs          # rebuilds when dirty
node tools/rebuild-index.cjs --force  # rebuilds regardless
```

Rebuild costs about **7.5s for ~360 notes / 820 chunks** on a laptop, and it runs
as a **separate process** — the server keeps answering while it works. The server
never rebuilds inside a request: search serves from the current index and reports
`indexStale: true`, so a stale index is visible rather than silently wrong.
You can also press "rebuild index" in Settings.

## Docs
| File | What it is |
|---|---|
| [`docs/CODE-MAP.md`](docs/CODE-MAP.md) | **Start here** — the architecture as measured against the code, with file:line references |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | layer-by-layer design |
| [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md) | frontmatter fields actually written |
| [`docs/MCP-SPEC.md`](docs/MCP-SPEC.md) | MCP surface |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | runtime files and operating model |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | what is planned vs shipped |
| [`docs/TEST-PLAN.md`](docs/TEST-PLAN.md) | test approach |
| [`docs/PRODUCT-VISION.md`](docs/PRODUCT-VISION.md) | why this exists |
| [`docs/SYSTEM-PROMPT.md`](docs/SYSTEM-PROMPT.md) | agent system prompt |
| [`docs/الدستور-الصارم.md`](docs/الدستور-الصارم.md) | the engineering constitution (§33/§35/§38 … referenced 197× in code) |

## License
MIT — see [LICENSE](LICENSE). Third-party attribution in [NOTICE](NOTICE).
