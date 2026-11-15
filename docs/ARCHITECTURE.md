# Cortex Technical Architecture

## Layer 1 — Storage
- Markdown notes in `vault/`
- JSON settings in `data/settings.json`
- frontmatter metadata: tags, importance, created, updated, source, url

## Layer 2 — Knowledge parsing
Server parses:
- title
- tags
- timestamps
- wiki links
- importance
- cached vector representation

## Layer 3 — Retrieval
Current hybrid retrieval (all implemented in `cortex-core.js`):
- lexical ranking
- hashed-vector semantic approximation (n-gram TF-IDF with Arabic normalisation, 512 dims)
- importance weighting
- **pluggable embedding providers** — `local-ngram` · `openai-compatible` · `ollama` (`embedTexts`)
- **graph-aware reranking** — `graphBoost` from `linkCount` (searchWithEmbeddings)
- **project-aware reranking** — `projectBoost`, exact project-key match
- **recency windows** — `recencyBoost`, 30-day decay
- MMR reranking across notes (lambda 0.72)

Not implemented:
- neural / dense embeddings from a large model (the default is lexical IR, not semantics)

## Layer 4 — Agent services
Current services (all implemented):
- note read/write
- graph generation
- backlinks
- AI chat with context injection
- link suggestions
- action extraction
- **contradiction detection** — `detectContradictions`
- **note classification** — `classifyNote`
- **decision extraction** — `extractStructuredInfo`
- **project-state synthesis** — `synthesizeProjectState`
- **duplicate detection** — `findDuplicate` (SHA-256 fingerprint)
- **living note updates** — `updateLivingNote`

## Layer 5 — MCP surface
`mcp-memory-server.js` (stdio) and `POST /mcp` (HTTP) serve **28 tools** from one
implementation (`cortex-mcp-core.js`): 20 read · 8 write. Writes are refused unless
explicitly enabled; HTTP requires `Authorization: Bearer`.
Optional future split (not required): `cortex-memory` · `cortex-agent` · `cortex-runtime`.

## Layer 6 — UI
Web client panels:
- notes list
- editor
- preview / split mode
- links pane
- graph pane
- memory pane
- review pane (classification, structured extraction, contradictions, history snapshots)
- settings
- **command palette (⌘K)** — `public/app.js` "palette ⌘K" section

## Runtime data flow
1. user edits note
2. server writes Markdown (atomic tmp+rename, per-note write chain)
3. watcher invalidates cache and emits event stream
4. client refreshes list / graph / active note
5. agent chat retrieves top relevant context
6. MCP consumers can query the same vault externally

## Security model
Implemented:
- local filesystem only
- binds to `127.0.0.1` by default (`APP_HOST` opt-in for LAN, refused without `CORTEX_ALLOW_REMOTE=1`)
- session token required for every mutating route (`requiresSession`, central gate)
- CSRF: mutating requests must come from a local origin
- Host-header check (421) against DNS rebinding
- CORS pinned to the exact same origin (scheme+host+port)
- CSP without remote sources; `X-Frame-Options: DENY`
- history snapshot reads are path-traversal safe
- **encrypted secrets store** — AES-256-GCM, `data/.keystore`, `enc:v1:` prefix
- **scoped MCP permissions** — 20 read / 8 write tools, read-only by default
- **audit log for agent writes** — hash chain + HMAC per row + tail anchor
- outbound URL guard (private/loopback blocked after DNS resolution)

Not implemented (stated plainly):
- HTTPS / multi-user / tenant isolation
- sensitive-note encryption at rest
- protection against a user who owns the disk

## Packaging model
- local dev server
- desktop wrapper candidate: Electron or Tauri
- portable vault root via `APP_ROOT`
