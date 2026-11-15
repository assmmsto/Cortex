# Cortex MCP Surface

## Current server
File: `mcp-memory-server.js`
Protocol: MCP over stdio with LSP-style framing

## Current tools (24)
Memory:
- `memory_search` / `memory_semantic_search`
- `memory_get_note` / `memory_upsert_note` / `memory_delete_note`
- `memory_recent` / `memory_related` / `memory_tag_search`
- `memory_stats` / `memory_dashboard` / `memory_list_projects`
- `memory_classify_note` / `memory_extract_structured`
- `memory_find_contradictions` / `memory_find_gaps`
- `memory_project_state` / `memory_resolve_reference`
- `memory_rebuild_index` / `memory_retrieval_status`

Agent:
- `agent_start_session` / `agent_capture_message`
- `agent_review_context` / `agent_next_best_action`
- `agent_update_living_note`

Transport details:
- stdio with LSP-style framing
- `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`,
  `prompts/list`, `resources/templates/list` are answered; unknown methods return a JSON-RPC error.

## Recommended full product split
### cortex-memory
- search / semantic search
- read / write / delete note
- recent / related / tag search
- stats / project state

### cortex-agent
- capture session
- summarize project
- review gaps
- extract decisions
- extract risks
- propose living note updates

### cortex-runtime
- attach repo context
- summarize diffs
- link code changes to memory
- create decision from code change

## Example runtime positioning
- Claude Code + Cortex MCP
- OpenCode + Cortex MCP
- DeepSeek Harness + Cortex MCP
- Generic model runtime + Cortex MCP
