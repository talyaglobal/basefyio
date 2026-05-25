## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

---

## Project Knowledge Policy

Before reading raw files, check the graphify knowledge graph first.

Preferred order:
1. `graphify query "<question>"` — scoped subgraph, fastest
2. `graphify explain "<concept>"` — focused concept + neighbors
3. `graphify path "<A>" "<B>"` — relationship tracing
4. `graphify-out/graph.json` — raw graph data
5. `graphify-out/GRAPH_REPORT.md` — broad architecture overview
6. Raw grep/read — only if graph is insufficient

Never scan entire repositories if graph answers exist.

- Architecture questions → prefer `graphify query`
- Dependency tracing → prefer `graphify path`
- Impact analysis → prefer graph traversal before file reading

Keep context usage efficient. Avoid loading unrelated files.

---

## Graphify — First Context Layer

Use Graphify as the first context retrieval layer.

Do not run rg/find/grep or open broad folders before trying:
- `graphify query "<task intent>"`
- `graphify explain "<domain concept>"`
- `graphify path "<source>" "<target>"` when tracing flow
- `graphify affected "<node>"` before refactors

Only read files returned by Graphify unless results are insufficient.
After code changes, run `graphify update .`.
Goal: minimize token usage and avoid whole-repo scanning.
