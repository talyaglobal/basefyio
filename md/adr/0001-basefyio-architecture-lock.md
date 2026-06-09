# ADR-0001: Basefyio Architecture Lock

> Status: **Accepted** | Date: 2026-06-06 | Decider: askin
> Supersedes: `ARCHITECTURE-NOSQL-COUCHBASE.md` (archived)
> Inputs: `BASEFYIO_IMPLEMENTATION_PROMPT.md` (Doc 2), `BASEFYIO-DATA-ENGINE-PROMPT.md` (Doc 3), `EXCEL-TO-APP-PLAN.md` (Doc 4), `PLAN-ALIGNMENT-REVIEW.md`

## Context

Four planning documents specified overlapping systems with conflicting designs: three document-store architectures, two storage abstractions, two metadata registries, four API surfaces, two app-builder runtimes, and three permission models. Proceeding without convergence would build the same concepts 2–3 times under different names and force a rewrite.

## Roles of the source documents

| Doc | Role |
|---|---|
| Doc 2 — Basefyio Implementation Prompt | **Primary platform roadmap** (minus §7 codegen — see D4) |
| Doc 4 — Excel → App Plan | **Primary product roadmap** |
| Doc 3 — Data Engine Prompt | **Architectural seam only** — interface shape, not a build mandate |
| Doc 1 — NoSQL Couchbase Architecture | **Archived / superseded** |

## Decisions

### D1 — Storage: Data Engine abstraction, Postgres JSONB only in V1

Adopt Doc 3's `DataEngine` abstraction (`packages/data-engine`, capability-based, lint-enforced boundary) with **`PostgresJsonbDataEngine` as the only V1 implementation**.

```
Application Layer → Basefyio Data Engine → PostgresJsonbDataEngine → PostgreSQL
```

`CouchbaseDataEngine` is a possible future provider behind the same interface (see D8). No Couchbase cluster, no bucket-per-project, no scope-per-project before a customer needs it.

### D2 — Metadata: one registry, split by concern

- **Platform DB** = application intelligence ("what app should exist?"): `Blueprint`, `ApplicationModel`, `ApplicationVersion`, `DomainTemplate`, `GenerationRun`, `AIAnalysis`, `PromptHistory`.
- **Tenant DB** = runtime metadata ("how does this project operate?"): `_bf_collections`, `_bf_fields`, `_bf_permissions`, `_bf_roles`, `_bf_flows`, etc.
- **Removed from Doc 3:** `EntityDefinition`, `EntitySchemaVersion` — they duplicate `_bf_collections`/`_bf_fields`. There is exactly one entity registry: the `_bf_*` tables. Doc 3's AI-provenance fields (`generatedByAI`, `aiPrompt`, `confidenceScore`, `sourceWorkbook`, `sourceSheet`, …) move to the platform-DB intelligence models.

### D3 — API: one canonical surface

- **Canonical:** `/items/:collection` (Directus-style filter AST).
- **Compatibility layer:** `/rest/v1/*` (Supabase/PostgREST syntax) mapped internally onto `/items/*` — for generated clients and ecosystem tooling.
- **Removed:** `/data/:entity` (Doc 3), `/doc/:collection` (Doc 1). Generated applications target the canonical/compat surface forever; no third path will exist.

### D4 — App builder: metadata runtime, not codegen

V1 adopts Doc 4 completely:

```
Excel → AI Understanding → Application Model → Nfyio Runtime
```

No generated repos, builds, deployments, or source code (APEX/Retool/Salesforce model). The Application Model + Nfyio Runtime is the source of truth. Doc 2 §7's codegen system is repositioned as a **V2 "Eject to Code" feature**, not the primary architecture. Single analyze endpoint: `/blueprints/analyze`.

### D5 — Generated app data: project PostgreSQL, two storage modes

V1 app data lives in the project's PostgreSQL database — reusing the existing provisioning, import pipeline, REST, and SQL modules. PostgreSQL serves **two runtime storage modes**, both behind the Data Engine / `/items` surface:

- **Structured collections → relational tables** with RLS, indexes, joins, analytics (`store: 'relational'` in `_bf_collections`). Default for Excel-derived entities.
- **Unstructured / flexible content → JSONB** (`store: 'document'`, `_bf_documents`-style). Covers CMS content, AI-generated content, arbitrary metadata, and workflow state — without introducing Couchbase.

App data does **not** go into an external document store until the D8 gate fires; JSONB is the flexible-content answer until then.

### D6 — Permissions: Keycloak + Postgres RLS in V1

V1 uses the existing, working Keycloak + RLS model. Doc 2's permission compiler arrives with the content layer (Step 3) and **compiles `_bf_permissions` into the existing model** (RLS + API guards + UI visibility) — it augments, it does not replace.

### D7 — Branding: Basefyio, enforced

Basefyio everywhere user-facing, effective immediately. "Kolaybase" is forbidden in customer-facing UI, docs, API responses, OpenAPI titles, emails, and errors — enforced by CI grep gate. Internal references (`kolaybase-new` repo name, legacy migration code) acceptable during transition only.

### D8 — Couchbase: a review gate, not a sprint

Couchbase is **not scheduled**. A gate review is triggered only when at least one of:

- 3 customers request offline-first/mobile sync
- a collection exceeds 10M documents
- document workloads exceed JSONB performance targets

Only then: Phase 0 interface review → Phase 1 Couchbase POC → Phase 2 production rollout. Until then `PostgresJsonbDataEngine` is the only implementation, and Doc 3's Phase 0 recon serves as the gate-review template.

## Master roadmap

| Step | Scope | Source |
|---|---|---|
| **0** | This ADR; archive Doc 1 | — |
| **1** | Basefyio rename: CLI, SDK, UI, docs, env vars, CI grep gate | Doc 2 §8 |
| **2** | Excel → App platform: blueprint models, add-in, AI analysis, Application Model, Nfyio runtime, AI chat | Doc 4 |
| **3** | Content & functions layer onto the Step-2 runtime: collections, items API, files, flows, RBAC compiler (per D6) | Doc 2 Sprints 1–6 |
| **4** | Couchbase gate review — only if D8 criteria met | Doc 3 (gated) |

## Consequences

- One runtime model, one API model, one metadata registry, one storage abstraction, one permission story.
- Doc 2 and Doc 3 implementation prompts must be edited before being fed to agents: strip Doc 2 §7 codegen (→ V2 eject), strip Doc 3's `EntityDefinition`/`EntitySchemaVersion`/`/data/:entity`/Couchbase-now provisions, keep its interface, envelope, outbox, and isolation-test ideas.
- Any future need that appears to require a second registry, API path, or runtime is treated as a design bug against this ADR, not a parallel build.
