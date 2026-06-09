# Plan Alignment Review — 2026-06-06

Docs reviewed: `ARCHITECTURE-NOSQL-COUCHBASE.md` (Doc 1), `BASEFYIO_IMPLEMENTATION_PROMPT.md` (Doc 2), `BASEFYIO-DATA-ENGINE-PROMPT.md` (Doc 3), `EXCEL-TO-APP-PLAN.md` (Doc 4).

## Misalignments

### 1. Three incompatible document-store designs
| | Doc 1 | Doc 2 | Doc 3 |
|---|---|---|---|
| Engine | Couchbase **now**, container **per project** | Postgres JSONB first; Couchbase only after Sprint-4 go/no-go gate | Couchbase **now**, **shared** bucket/collections + `_projectId` discriminator |
| Abstraction | none (direct `couchbase` module) | `CollectionStore` (platform-api module) | `DataEngine` (`packages/data-engine`) |
| Exposure | N1QL editor, `kb.doc()`, maybe brand as "CouchBase" | engine never named | engine never named |

Doc 3 explicitly forbids Doc 1's model ("do NOT provision a scope per project", "never provision dedicated buckets"). Doc 1 contradicts both newer docs on tenancy, branding, and abstraction. **Doc 1 is superseded — archive it.**

### 2. Two competing abstraction interfaces for the same job
`CollectionStore` (Doc 2 §3.4) vs `DataEngine`/`EntityCollection` (Doc 3 §1). Same responsibility, different shape, different package location. Pick one.

### 3. Metadata location contradiction
- Doc 2, Key Decision #1: collection/field/permission metadata lives in the **tenant DB** (`_bf_*` tables).
- Doc 3: `EntityDefinition`, `EntitySchemaVersion`, `ApplicationModel` live in the **platform Prisma DB**.
- Doc 4: `Blueprint`, `ApplicationVersion`, `DomainTemplate` in the **platform DB**; `app_entities` in tenant DB.

Doc 2's `_bf_collections/_bf_fields` and Doc 3's `EntityDefinition/EntitySchemaVersion` are the same registry built twice in different databases.

### 4. Four data-API surfaces
- Doc 1: `/api/rest/v1/doc/:collection` (PostgREST-style operators)
- Doc 2: `/items/:collection` (Directus filter AST `_eq/_and`) + Supabase-compat `/rest/v1` alias in Sprint 6
- Doc 3: `/v1/projects/:projectId/data/:entity` (own filter AST, cursor pagination, If-Match)
- Doc 4: existing pg-direct `rest/v1` (already shipped)

Generated apps can only target one. Doc 2 says generated apps use the `/rest/v1` alias; Doc 3 says generated app records go through `/data/:entity`; Doc 4 says existing `rest/v1` against real PG tables.

### 5. App builder built twice, with opposite runtime philosophies
- Doc 2 §7: AppSpec → **codegen** — Next.js/Expo repo archives from `packages/app-templates`; endpoint `/app-builder/analyze`; KolayPhoto fixture.
- Doc 4: Blueprint/Business Model/Application Model → **metadata-driven Nfyio runtime**, explicitly "no per-project codegen, builds, repos, or deployments"; endpoint `/blueprints/analyze`.
- Doc 3 adds a third skeletal `ApplicationModel` Prisma model "to reserve the seam".

Direct conflict. Doc 4's runtime approach and Doc 2's codegen approach can't both be V1. (Doc 4's post-V1 item 8 "eject-to-code" is the natural home for Doc 2's codegen.)

### 6. Where do generated-app records live?
Doc 3: Couchbase data plane holds "generated application records, dynamic form submissions". Doc 4 Phase 3: real PG tables per project + RLS (reusing existing DDL/import). Mutually exclusive for V1.

### 7. Three permission models
Doc 2: `_bf_roles/_bf_policies/_bf_permissions` compiled in the store layer (Directus 11 model). Doc 4: Application Model permissions → Keycloak realm roles + compiled RLS policies. Doc 3: Keycloak + project-membership guards only. The "zero bypass paths" guarantee (Doc 2 §10) can only be true for one of them.

### 8. Branding drift
Doc 2 hard rule: full Basefyio rename Sprint 0, "Kolaybase" never user-facing, engines never named. Doc 1 still says KolayBase and floats exposing "CouchBase". Doc 4 leaves "how visible Kolaybase remains in marketing" open — contradicts Doc 2's CI grep-gate.

### 9. Capacity not reconciled
Doc 2 = ~14 weeks (7 sprints). Doc 4 = ~11–14 weeks. Doc 3 = 7 phases. All assume solo dev + AI agents, none sequenced against the others. Run in parallel they collide on the same files (`projects`, `sdk`, `app-sidebar.tsx`, Prisma schema).

## What IS aligned
Basefyio brand + engine-neutral naming (Docs 2–4); abstraction-over-engine principle (2, 3); JSONB-as-default with Couchbase gated by real demand (2, and 3's `PostgresJsonbDataEngine` makes this cheap); Excel→app as the product wedge (2 §7, 4); reuse of existing modules (queue, ai, data-import, realtime, storage); graphify workflow.

## Decisions needed before any code (Step 0)
1. **One store abstraction** — recommend Doc 3's `DataEngine` package shape (cleaner boundary, lint-enforceable) but with Doc 2's JSONB-first/Couchbase-gated rollout. Drop Doc 1.
2. **One metadata home** — split by concern: content/collection/permission metadata in tenant DB (Doc 2), blueprint/app-model/provenance in platform DB (Doc 4). Merge `EntityDefinition` into `_bf_collections` — don't build both.
3. **One items API** — recommend Doc 2's `/items/:collection` + the Supabase-compat `/rest/v1` alias; fold Doc 3's envelope/optimistic-concurrency ideas into it. Kill the `/data/:entity` and `/doc/:collection` surfaces.
4. **One app builder** — Doc 4's blueprint pipeline + Nfyio runtime is V1; Doc 2 §7 codegen becomes post-V1 "eject". Unify on `/blueprints/analyze`.
5. **One permission story for V1** — Doc 4's Keycloak+RLS (it ships with existing infra); migrate to Doc 2's policy compiler when the content layer lands.
6. **Branding** — adopt Doc 2 §8 fully; close Doc 4's open question (Kolaybase = internal only).

## Recommended execution order
| Step | What | Source | Why this position |
|---|---|---|---|
| 0 | Decision memo locking the 6 items above; archive Doc 1 | — | Everything downstream forks on these |
| 1 | Rebrand + foundations (Sprint 0: env/CLI/SDK/strings, CI grep-gate) | Doc 2 §8 | All user-facing work depends on the name; cheapest now |
| 2 | Excel→App V1 (Phases 0–6: blueprint models, add-in, AI layer, generation on existing PG + rest/v1, Nfyio runtime, AI chat) | Doc 4 | Highest product value; ~80% reuses shipped modules; needs neither the content layer nor Couchbase |
| 3 | Content & functions layer (collections, items API, RBAC policy compiler, files, flows) — with §7 app builder removed/merged into Step 2's pipeline | Doc 2 Sprints 1–6 | Platform depth after the wedge proves demand; its `/rest/v1` alias and policy compiler then upgrade the generated apps |
| 4 | Couchbase data engine — only if the gate fires (mobile-sync customer or >10⁷-doc collections); JSONB until then | Doc 3 (gated by Doc 2 §3.4) | Zero new infra meanwhile; Doc 3's Phase 0 recon becomes the gate review |

Net effect: one rename, one metadata registry, one API surface, one app builder, Couchbase deferred behind evidence.
