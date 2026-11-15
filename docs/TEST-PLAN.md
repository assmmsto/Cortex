# Cortex Test Plan

## Automated
- API tests (`tests/api.test.mjs`)
- MCP tests (`tests/mcp.test.mjs`)
- retrieval tests (`tests/retrieval.test.mjs`)
- syntax checks for server and client scripts

## Manual smoke
- create note
- search note
- semantic search
- graph render
- external vault change refreshes UI
- model settings save / load
- MCP client connects and lists tools
- restore a note from its history snapshot

## Architecture validation
- verify vault portability via `APP_ROOT`
- verify local-first behavior with no external model
- verify memory server can mount into external runtimes
