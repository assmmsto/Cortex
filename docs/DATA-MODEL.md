# Cortex Data Model

## Current frontmatter
- tags: string[]
- importance: number
- type: note | decision | task | project | risk | meeting | question | procedure | doc | state | living_note
- documentType: spec | design | decision | meeting | runbook | plan | note
- project: string
- created: ISO timestamp
- updated: ISO timestamp (refreshed on every save)
- source: string (optional)
- url: string (optional)
- status: draft | active | archived | blocked | done (optional)
- owner: string (optional)

Fields with empty values are omitted from the written frontmatter.

## Recommended additions
- confidence: number
- derived_from: string[]
- relations: object[]
