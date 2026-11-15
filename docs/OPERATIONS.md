# Cortex Operations

## Durability features
- note history snapshots before overwrites/deletes (identical consecutive snapshots are skipped)
- explicit backup endpoint writing real ZIP archives with a built-in writer (no external `zip` binary)
- workspace audit log in `data/audit.log`
- session persistence in `data/sessions/`
- cache invalidation and filesystem watch refreshes delivered to the UI over SSE (`/api/watch`)

## Runtime files
- `data/vector-index.json` — persistent retrieval index (chunks + embeddings)
- `data/vector-index.dirty.json` — small marker meaning "index needs rebuild"; keeps note saves
  from rewriting the whole index
- `data/workspace-state.json` — active note/project, recents, last resolved reference

## Recommended operating model
1. run local-first by default
2. use backups before large migrations
3. review workspace health score regularly
4. promote important project notes into living notes
5. connect external runtimes via MCP rather than giving them raw file access when possible

## Stress considerations
- read paths use cached note index when possible
- write paths snapshot previous content before mutation
- watch stream refreshes clients without polling loops
- hybrid retrieval stays local and deterministic in mock mode
- outbound model/embedding calls are bounded by timeouts
  (`APP_MODEL_TIMEOUT_MS`, `APP_MODELS_TIMEOUT_MS`) and request bodies by `APP_MAX_BODY_BYTES`

## Recommended next production hardening
- encrypted secret store
- append-only event journal for note mutations
- SQLite metadata index for larger vaults
- bounded worker queue for background analysis
- desktop wrapper with crash recovery
