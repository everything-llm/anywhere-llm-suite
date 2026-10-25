# notebook-lean

A notebook AnythingLLM's agent keeps for itself: short notes that every chat and scheduled job share, written at the agent's own judgement. It took the place of the memory skill (archived on the branch `archive/memory-skill`), without its embedder and vector database.

- **Actions:** `read` (the newest notes, or those holding a query's words, rarer words counting more), `write`, `edit` and `delete` by a note's number.
- **Meaning without a model:** the search matches words, so the description asks the agent to bring the meaning: a query with the subject plus synonyms, related words and names, and on `write` or `edit` a note's `keywords`, words a later search might use that its text lacks. An edit without keywords keeps the note's.
- **Where:** one file, `<storage>/notebook-lean/notebook.json`, changed under its lock, since a scheduled job runs in a process of its own. Uninstalling the skill leaves it.
- **Limits:** 500 notes, 1000 characters each and 200 for a note's keywords; a read shows 30.
- **What it needs of AnythingLLM:** the storage folder (`STORAGE_DIR`), and nothing else: no model, no vectors, no server modules, no workspace scope.

## Check

`tests/handler.test.mts` runs against the built bundle (`npm run skills:test` in `packages/`).
