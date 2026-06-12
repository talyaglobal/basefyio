# Provider-Aware Query Editor — Implementation Plan

> Status: PROPOSED (v1, 2026-06-12) · Owner: platform team
> Driven by customer request: "When MongoDB backs the project, the SQL editor
> becomes an aggregation editor; when CouchDB backs it, queries should be
> written like pure JS with a SQL-editor-like UX."

---

## 0. Reconciling the request with existing specs

Two committed design documents already constrain this feature:

| Source | Constraint |
|---|---|
| `md/BASEFYIO_DEVELOPER_ACCESS_DNS_SECURITY_SPEC.md` v0.8 (§2.2, §4.1) | JSON data gets a **unified, engine-agnostic JS Query Editor** (`collection.find(...)`, `.filter(doc => ...)`); the backing engine (Mongo-style vs Couchbase-style) is an internal decision the user never sees; aggregation "may exist under the hood … never surfaced as an engine-named editor". `QueryEditorMode = 'sql' \| 'js-query'` already exists in code (`data-structures.service.ts`). |
| `md/BASEFYIO-DATA-ENGINE-PROMPT.md` §8 | Exactly two surfaced query modes — SQL-like → `EntityQuery` and the vendor-neutral **Basefyio Aggregation DSL** → `EntityAggregation`; naming lock (no "native/raw/provider aggregation" anywhere); user query text never reaches the provider; callers branch on `capabilities()`, never provider name (CI-enforced, `md/data-engine.md` §19). |

**Resolution** (satisfies the customer's functional ask without violating either spec):

1. The **JS Query Editor** is the primary query surface for every NOSQL
   project — regardless of backing engine. This directly delivers the CouchDB
   ask ("write queries like pure JS, SQL-editor UX") and also covers
   Mongo-backed deployments.
2. The **Aggregation editor** is a second mode in the same page, labeled
   "Aggregation" (Basefyio Aggregation DSL — never an engine name), shown only
   when the live engine reports a new capability flag
   `aggregationPipeline: true`. In practice: a MongoDB-backed data plane
   surfaces it natively (the customer's "Mongo ⇒ aggregation"), CouchDB
   surfaces it later once its in-memory pipeline executor ships.
3. Relational projects keep the existing SQL Editor unchanged.

The selector is **capabilities + `databaseType`**, never the provider name —
both in the UI and in the API.

---

## 1. Current state (verified in code, 2026-06-12)

- **Query AST is ready**: `packages/data-engine/src/interfaces/query.ts` ships
  `Filter` (15 operators), `EntityQuery`, `EntityAggregation` (7 allowed
  stages, 5 accumulators, blocked-stage set incl. `$function`/`$where`),
  `DataEngineSqlQuery`, `SavedDataQueryDef`, `QueryExplainResult`.
- **No parser exists**: `src/query/` ("reserved for query parsers — Phase 2")
  is absent; `DataEngineSqlQuery` is never constructed anywhere.
- **`EntityCollection.query()` is real in all three providers** (postgres
  JSONB, couchdb Mango, couchbase N1QL) — a frontend compiling to
  `EntityQuery` works today.
- **`aggregate()` and `explain()` are stubs in all three providers**; nothing
  in the repo calls them. Aggregation mode is dark until Phase 3.
- **No MongoDB provider / dependency exists.** Internal plumbing anticipates
  it: `schema.prisma` `jsonBackend "mongodb"|"couchbase"` (internal-only),
  `DataStructureStorage.engineType`, and JSON data structures already default
  to `jsonBackend: 'mongodb'` (`data-structures.service.ts:72`).
- **SQL editor stack to mirror**: `components/sql-editor.tsx` (407 lines,
  plain `<textarea>`, multi-tab + localStorage, Ctrl+Enter, paginated results,
  MD/JSON copy, Excel export) → `POST /api/sql/execute` → `SqlService`
  (team-membership check, blacklist validation, pagination wrapper, 30s
  timeout, `SqlAuditLog`, activity events, embedding indexing).
- **No code-editor library** (no CodeMirror/Monaco anywhere) and **no JS
  sandbox** (no isolated-vm/quickjs/node:vm) exist yet.
- **No NOSQL guard on /sql today**: the SQL editor renders and works against a
  NOSQL project's (empty) system Postgres DB.
- **SDK already speaks the target dialect**:
  `bf.data.collection('patients').find({ 'address.city': 'NY', age: { $gt: 30 } }).sort(path, dir).limit(10)`
  (`packages/sdk/src/modules/data-engine.ts`). The editor's JS dialect should
  mirror the SDK 1:1.
- **`SavedDataQuery` Prisma model exists unused** (`saved_data_queries`).
- **Capability plumbing gap**: `ProviderCapabilities` has no query/aggregation
  flag; `capabilities()` is consumed only by the contract test — no API
  endpoint or UI reads it. The runtime provider can silently differ from the
  configured one (couchdb/nosql → postgres fallback), so capabilities MUST be
  read from the live engine, not from config.

---

## 2. Architecture decisions

### D1 — JS queries are parsed, never executed (V1)
User text like

```js
collection('orders')
  .find({ status: 'paid', 'customer.city': { $in: ['Istanbul', 'Izmir'] } })
  .sort({ _createdAt: -1 })
  .limit(50)
```

is parsed server-side with **acorn** (AST parse only — no eval, no Function,
no sandbox needed) and compiled to the existing validated `EntityQuery`. The
grammar is a closed allowlist:

- Root: `collection('<name>')` (alias `db.<name>` accepted, normalized).
- Chain: `.find(filterObj)` · `.sort(sortObj | path, dir)` · `.limit(n)` ·
  `.skip(n)` / `.offset(n)` · `.select(projection)` · `.count()`.
- Filter objects: literal JSON values + Mongo-style operators mapped to
  `FilterOperator` (`$eq $ne $gt $gte $lt $lte $in $nin $contains $exists
  $regex $iregex $and $or $not` — same set the SDK and the legacy
  `nosql-filter.util.ts` already use).
- Anything else (identifiers, calls, template strings, arrow functions in V1)
  → `QueryValidationError` with a precise position message.

This keeps the hard guarantee from the data-engine spec: *user query text
never reaches the provider*; `_projectId` injection and operator allowlists
happen in the existing engine layer.

### D2 — `.filter(doc => …)` / `.map` / `.reduce` arrive in V2 via QuickJS-WASM
The v0.8 spec requires a sandboxed adapter for arbitrary-predicate queries and
leaves the runtime open (isolated-vm vs QuickJS). **Recommendation:
`quickjs-emscripten` (pure WASM)** — no native build step (isolated-vm
requires node-gyp, painful in the Alpine Docker images and Windows dev), easy
hard limits (interrupt handler for CPU, memory cap per VM, no host bindings =
no IO/network/require by construction). Execution model: the parsed chain runs
the AST part first (server-side, bounded `limit`), then the sandboxed predicate
post-filters/maps the bounded result set. Never unbounded collection scans
through the sandbox.

### D3 — Aggregation mode is capability-gated, not engine-named
- Extend `ProviderCapabilities` with `aggregationPipeline: boolean`
  (+ contract-test assertion).
- New endpoint exposes the **live** engine's capabilities (see Phase 2) —
  config-based detection is wrong because of the silent postgres fallback.
- UI shows the "Aggregation" tab only when the flag is true. Labels follow the
  naming lock: "Query", "JS Query", "Aggregation" — never Mongo/CouchDB/
  Couchbase. (Add the forbidden-phrase scan to CI alongside
  `check:english-ui`.)

### D4 — MongoDB enters as a 4th data-engine provider
`packages/data-engine/src/providers/mongodb/mongodb-engine.ts`, optional peer
dep `mongodb`, selected by `DATA_ENGINE_PROVIDER=mongodb`, passing the same
`providerContractSuite` (the couchdb provider added in June 2026 is the
template for the whole checklist: factory case, config union, platform-api
fallback, compose service, env, contract test, docs). `aggregate()` compiles
`EntityAggregation` to a native pipeline with the stage/accumulator allowlist
enforced *before* hitting the driver and `_projectId` injected into the first
`$match`. `capabilities()` reports `aggregationPipeline: true`.

### D5 — One adaptive route, `/sql`
Keep the route (deep links, `isFullHeightRoute` already covers it). The page
reads `useProject().databaseType`:
- `RELATIONAL` → existing `SqlEditor` untouched.
- `NOSQL` → new `QueryEditor` (JS mode default; Aggregation tab when capable).
Nav label becomes dynamic: "SQL Editor" / "Query". The `/sql/execute` backend
endpoint stays for relational projects; NOSQL projects use the new
`/data-query/*` endpoints (and the UI no longer offers raw SQL against the
system Postgres DB for them).

---

## 3. Phases

### Phase 1 — Query frontends in `packages/data-engine/src/query/` (~2–3 days)
The directory the docs reserved for exactly this.
- `js-query-parser.ts`: acorn-based parser → `{ entity, query: EntityQuery } |
  { entity, count: true, filter }`. Rich errors (line/col, "did you mean").
- `aggregation-validator.ts`: untrusted JSON → `EntityAggregation`; enforce
  `ALLOWED_AGGREGATION_STAGES` / `ALLOWED_ACCUMULATORS` /
  `BLOCKED_AGGREGATION_STAGES`; depth/size caps from `DataEngineConfig`.
- `ProviderCapabilities.aggregationPipeline` + per-provider values
  (postgres/couchdb/couchbase: `false` for now) + contract-test update.
- Exhaustive unit tests incl. adversarial inputs (prototype pollution keys,
  `__proto__`, `$where` smuggling, 1MB filters, deep nesting).

### Phase 2 — Platform API endpoints (~2 days)
Module `data-query` mirroring `SqlService`'s proven shape (membership check,
duration, audit, activity):
- `POST /api/v1/projects/:projectId/data-query/js` — body `{ source, page?,
  limit? }` → parse → `engine.collection(...).query(...)` / `.count()` →
  `SqlResult`-compatible response (`rows/fields/rowCount/duration/total`) so
  the UI grid is reusable.
- `POST .../data-query/aggregation` — body `{ entity, pipeline }` → validate →
  `engine.aggregate()`.
- `POST .../data-query/explain` — wired to `engine.explain()` (stub-honest:
  returns what providers give today).
- `GET .../data-query/capabilities` — `{ provider-agnostic caps + queryModes:
  ['js', ...('aggregation' if capable)] }` read from the **live** engine.
- Saved queries CRUD on the existing `SavedDataQuery` model (extend `mode`
  values with `'js'`).
- Audit: new `DataQueryAuditLog` (or `sql_audit_logs` + `dialect` column —
  decide in review; activity kinds `DATA_QUERY_EXECUTED/FAILED`).

### Phase 3 — Aggregation execution (~3–4 days)
- **MongoDB provider** per D4, with docker-compose dev profile + optional prod
  service (couchdb rollout playbook applies: compose, `.env*`, healthcheck,
  contract suite against a live container in CI-optional mode).
- **Shared in-memory pipeline executor** in data-engine (operates on scanned
  docs; same bounded-scan discipline as the couchdb provider's query path) so
  couchdb/postgres can flip `aggregationPipeline: true` without native
  pipeline support. Ship behind the capability flag — Mongo first, others
  after.

### Phase 4 — Admin UI (~3–4 days)
- Add **CodeMirror 6** (first code-editor dep; SSR-safe, small, JS/JSON/SQL
  modes + autocomplete). Optionally migrate `SqlEditor`'s textarea later —
  out of scope here.
- New `components/query-editor.tsx` reusing the SqlEditor shell patterns
  (multi-tab + localStorage `basefyio_query_editor_tabs_${projectId}`, rename,
  Ctrl+Enter, paginated grid, MD/JSON copy, Excel export, error panel):
  - **JS Query tab**: CodeMirror JS mode, snippet templates, entity/collection
    name autocomplete from `listEntityDefinitions` + `listCollections`,
    operator autocomplete inside `find({...})`.
  - **Aggregation tab** (capability-gated): CodeMirror JSON mode with stage
    templates ($match/$group/...), client-side schema validation mirroring the
    server validator, JSON + table result views.
  - Saved queries side panel (list/save/run) on the Phase-2 CRUD.
- `/sql/page.tsx` branches on `useProject().databaseType`; nav label dynamic
  in `layout.tsx` (project already in `ProjectProvider`).
- English-UI check + naming-lock scan green.

### Phase 5 — Sandboxed JS (V2, ~3 days, separate release)
- `quickjs-emscripten` adapter in platform-api (`query-sandbox.service.ts`):
  50ms CPU interrupt, 32MB memory, no host functions; executes
  `.filter/.map/.reduce` callbacks over the bounded result set from the AST
  part of the chain. Parser upgraded to accept arrow functions and route them
  to the sandbox. Resolves the spec's open decision #3.

### Phase 6 — Guards, docs, cleanup (~1–2 days)
- Hide raw SQL for NOSQL projects (frontend route branch is the UX; add a
  `databaseType` check in `SqlService.execute` as defense-in-depth — return a
  clear 400 pointing to `/data-query`).
- `md/data-engine.md` §9/§10 updates; CHANGELOG; SDK docs cross-link (the SDK
  dialect already matches the editor dialect — advertise that).
- CI: forbidden-phrase scan (naming lock) + ESLint `no-restricted-imports` for
  the mongodb SDK outside its provider dir.

---

## 4. Risks & open points

| Risk | Mitigation |
|---|---|
| Aggregation tab dark for couchdb until in-memory executor ships | Capability gate keeps it invisible rather than broken; Mongo-backed deployments get it on day one |
| Runtime provider ≠ configured provider (silent postgres fallback) | Capabilities endpoint reads the live engine instance |
| JS dialect scope creep ("why doesn't `Date.now()` work?") | Closed-grammar error messages name the supported surface; docs page lists the dialect explicitly; V2 sandbox absorbs predicate use-cases |
| Per-request `pg.Pool` pattern in SqlService is costly | Out of scope; data-query path uses the singleton engine, no new pools |
| `data-structures` module (v0.8 spec) overlaps at structure level | `editorMode: 'sql'\|'js-query'` there stays the source of truth per-structure; this plan implements the project-level editor on the same dialect/parsers, so the structure-level editor reuses Phase-1 parsers unchanged |

## 5. Effort summary

~11–16 developer-days total: P1 2–3, P2 2, P3 3–4, P4 3–4, P5 3 (separate),
P6 1–2. Recommended release slicing: **R1 = P1+P2+P4 (JS Query Editor live on
all NoSQL projects, incl. CouchDB)** → **R2 = P3 (Mongo provider + Aggregation
mode)** → **R3 = P5 (sandboxed predicates)**.
