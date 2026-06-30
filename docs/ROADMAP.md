# Roadmap

basefyio is the **core backend platform** of the MYFYIO ecosystem. AI capabilities
(agents, RAG, embeddings, semantic/vector search) are **intentionally not** part of
the core — they belong to **agentfyio** and other MYFYIO products. See
[architecture.md](architecture.md) for the ecosystem boundary and governance rules.

> If you're wondering "where is AI / RAG / vector search?" — it's deferred to
> agentfyio by design, not missing. This keeps the core reusable and independent.

**Status legend:** ✓ done & green · ◐ in progress · ☐ planned

---

## v0.1 Alpha — *in progress (stabilizing)*

The first public release: a focused, self-hostable backend platform with one
database abstraction (Prisma).

- ✓ `@basefyio/cli` — `basefyio --version`, `basefyio doctor`
- ✓ `@basefyio/sdk` — client SDK (`createClient`, `health`, `sql`)
- ✓ pnpm monorepo + CI for initialized packages
- ◐ Platform API core runtime (NestJS) — migrating from the original platform
- ◐ Authentication (Keycloak realms, JWT, API keys)
- ◐ Projects & provisioning
- ◐ SQL engine
- ◐ Storage (MinIO)
- ◐ Data engine / data query / data structures
- ◐ Realtime & realtime-data
- ◐ Queue · Redis · Observability · Health · Infrastructure · PgBouncer · Teams · Email
- ◐ Admin UI (preview) — Next.js dashboard: login, projects, SQL editor, storage, in-browser playground
- ☐ Tag `v0.1.0-alpha` once the platform API compiles and CI is fully green

## v0.2

- ☐ Admin UI — promote from preview to supported
- ☐ Storage API
- ☐ Realtime improvements
- ☐ Documentation expansion

## v0.3

- ☐ Kubernetes / Helm chart
- ☐ Multi-node deployment
- ☐ Backup / restore

## Future — MYFYIO ecosystem (separate products)

These build **on top of** basefyio and are out of scope for the core:

- ☐ **agentfyio** — AI runtime (agents, RAG, embeddings, semantic/vector search, recommendation)
- ☐ **mcpfyio** — MCP platform
- ☐ **deployfyio** — deployment platform
- ☐ **codefyio** — development environment

---

## Stable public contract (from v0.1)

Once published, these interfaces are treated as stable and won't break
unnecessarily: **REST API · CLI · SDK · configuration · Prisma schema.**
