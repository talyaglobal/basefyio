# Sharefyio — Standalone Data Platform (Master Prompt v4.3 — FINAL, ready for repo bootstrap)

**Revision v4.3** (2026-06-06) — addendum consistency pass: A2 rewritten to the §2.1
sub-provider composition (flat interface removed), A7 gains `parent_child`, A13 test
list synced with the master contract suite (schema plan/rollback, stale-plan
rejection, MCP masking/explain-plan/approval-queue).

**Revision v4.2** (2026-06-06) — Strapi differentiation: **Safe Schema Change System**
(migration preview, dry-run, rollback snapshot — answers Strapi's migration/upgrade
pain) and **AI Data Gateway / MCP Guardrails** (permission firewall, field masking,
explain-before-write, human approval) added as the two killer features; both wired
into SchemaProvider flow, MCP section, and sprints S2–S4.

**Revision v4.1** (2026-06-06) — v3 residue cleanup: platform-PG metadata uses plain
Prisma model names (Collection, Field, Page, Block, Revision, ...) — `_sf_` prefix
survives ONLY on server-owned fields inside content documents; addendum §A4/§A6/§A12
rewritten in place (no `_sf_meta_*` anywhere); sprint S1 and First Tasks now say
`DataEngineProvider` with both provider skeletons. **This prompt is ready for repo
bootstrap.**

**Revision v4** (2026-06-06) — architectural review fixes: **metadata moved to platform
PostgreSQL as single source of truth** (no `_sf_meta_*` in NoSQL — Studio is now fully
provider-independent); `DataEngineProvider` **split into sub-providers** (schema/items/
aggregate/realtime); **MCP hard rule** (tools may only call SchemaRegistry +
PermissionCompiler + DataEngineProvider); **Website Builder pulled to S5**; launch
template catalog expanded to 10; **`parent_child` tree relation** added for NoSQL;
ecosystem landing message.

**Revision v3** (superseded) — §2.1 upgraded from `DatabaseProvider` to
**`DataEngineProvider`: SQL + NoSQL from day one**; sprint S0–S3 build both providers
in parallel; NoSQL Data Engine Addendum appended.

**Revision v2** (superseded) — strategic revisions: positioned as a **Data Platform**
(not "headless CMS"); `DatabaseProvider` abstraction for multi-DB roadmap; **MCP pulled
forward to Sprint 3** as the primary differentiator; **Website Builder** layer
(Page → Block → Preview → Publish); **app templates** moved earlier; Basefyio /
Sharefyio / Nfyio ecosystem positioning.

> **Sharefyio** is an independent product: a Directus-class data platform with its own
> repo, own infrastructure, and own brand (sharefyio.com). It is NOT a Basefyio module.
> Basefyio stays a pure backend platform; ALL content/studio capabilities live here.
>
> This document is the bootstrap prompt for the new `sharefyio` repo. The detailed
> feature specs already written for the (now-cancelled) Basefyio CMS module remain the
> engineering source of truth — copy them into the new repo and apply the §9 rename
> mapping:
> - `kolaybase-new/md/BASEFYIO_IMPLEMENTATION_PROMPT.md` §3–§7 (data model, APIs, UI,
>   function runtime, app builder)
> - `kolaybase-new/md/BASEFYIO_HEADLESS_CMS_PROMPT.md` (field system, versioning,
>   translations, layouts, flow operations, realtime, insights, MCP)
> - `kolaybase-new/md/refs/` (Directus 11 screenshots = UX ground truth, KolayPhoto
>   fixture, Supabase data-api patterns)

---

## 1. Product Definition & Positioning

**One-liner:** "Sharefyio — connect any database and instantly get a studio, APIs,
automations, realtime subscriptions, MCP tools, and deployable websites."

**Category language (hard rule):** Sharefyio is a **Data Platform / Backend Studio /
Universal Admin Panel** — NOT marketed as a "headless CMS". CMS is one use case among
many. Landing-page vocabulary: "Data Platform", "Content Platform", "Backend Studio",
"Universal Admin Panel". Avoid "CMS" as the category noun. Why: users build CRMs, ERPs,
inventory systems, and internal tools — not just content sites (this is exactly how
Directus outgrew the CMS market).

- **Audience:** anyone with a SQL database — content teams, agencies, publishers, AND
  teams building CRM/ERP/inventory/internal tools; AI developers who want their agents
  to read/write structured data safely (via MCP).
- **Core promise:** point Sharefyio at a database → it introspects existing tables,
  registers metadata in the Sharefyio platform (**no system tables are created in your
  database**), and gives you the Studio, REST/GraphQL APIs, RBAC, files, flows,
  insights, realtime, MCP tools, and publishable websites.
- **Database modes per project:**
  1. **Managed** — Sharefyio provisions a Postgres DB for the project.
  2. **Bring-your-own** — any reachable PostgreSQL: Basefyio, Supabase, Neon, RDS,
     Crunchy, self-hosted. (TAM = everyone running Postgres, not just Basefyio users.)
     A Basefyio project DB is just a special case; an optional first-class "Connect
     Basefyio project" flow can come later, but Sharefyio must never depend on
     Basefyio to function.
- **Multi-engine roadmap:** v1 ships PostgreSQL + a vendor-neutral NoSQL Document
  Store, both behind the `DataEngineProvider` interface (§2.1) from day one —
  MySQL/SQL Server/CockroachDB are follow-on `kind:"sql"` providers, not rewrites.
- **Brand rules:** product name **Sharefyio**, domains `sharefyio.com`,
  `app.sharefyio.com`, `api.sharefyio.com`. No "Kolaybase", no "Basefyio", no
  "Directus" in user-facing UI, API responses, OpenAPI titles, emails, or errors.

**Ecosystem positioning (three independent, connectable products):**

- **Basefyio** — AI-native backend platform: databases, APIs, auth, storage, and
  business applications from spreadsheets and natural language.
- **Sharefyio** — connect any PostgreSQL database and instantly get a studio, APIs,
  automations, realtime, MCP tools, and deployable websites.
- **Nfyio** — deploy and host applications, websites, APIs, and AI workloads.

```
Excel → Basefyio → PostgreSQL → Sharefyio → Content/APIs/MCP → Nfyio → Deployment
```

Each product works standalone; the chain is an integration story, never a dependency.
Sharefyio's "Publish" and app-template outputs should treat Nfyio as the default deploy
target (one-click) with plain exports (zip/git repo, Vercel/Netlify adapters) always
available.

**Ecosystem landing message (the chain no competitor offers — Directus/Supabase/Strapi
each cover one link, none cover Excel → AI → Database → Studio → MCP → Website →
Deploy):**

> **Build your database with Basefyio. Manage it with Sharefyio. Deploy it with
> Nfyio. Let AI work on it through MCP.**

### 1.1 Strapi Differentiation — Why Sharefyio Wins

Sharefyio must not compete as "another headless CMS." Strapi already owns that mental
category (and its public pain points are exactly where Sharefyio attacks: painful
v4→v5 migrations and upgrade regressions, admin lag on large documents, data-loss risk
on content-type changes, missing rollback/transaction workflows for production).
Sharefyio wins by solving production data-platform problems that CMS-first tools
struggle with:

1. **Safe Schema Change System.**
   Every collection/field/schema change must generate a **migration preview before
   apply**: affected collections, affected records (counts), destructive-change
   warnings, generated DDL or provider operation plan, dry-run result, rollback
   snapshot, and one-click restore metadata. No schema change may run in production
   without a preview step unless the project owner explicitly enables unsafe
   fast-apply.
   Launch headline: **"Change your data model without breaking production."**

2. **AI Data Gateway / MCP Guardrails.**
   MCP is not just an API wrapper. It is a **governed AI data gateway**. Every AI tool
   call must pass through role permissions, row filters, field masking, dry-run-by-
   default writes, audit logs, rate limits, and optional human approval for
   destructive actions. Dangerous writes must return an **explain-plan before
   execution**.
   Launch headline: **"Let Claude work on your database safely."**

**Strategic rule:** Do not position Sharefyio as "better Strapi." Position it as:
*"Strapi is a CMS. Sharefyio is a governed data platform for humans, apps, and AI
agents."*

---

## 2. Repo & Infrastructure (new repo: `sharefyio`)

Mirror the proven Kolaybase stack — same team, zero learning curve — but fully
independent deployment:

```
sharefyio/
  apps/
    api/        NestJS + Prisma  (platform: workspaces, projects, billing, connections)
    studio/     Next.js 14 + Tailwind + shadcn/ui  (the CMS Studio)
    website/    marketing site (sharefyio.com)
  packages/
    sdk/        @sharefyio/sdk  (typed client: items, files, auth, realtime)
    cli/        sf  (link, gen, migrate, start)
    app-templates/  generated web/mobile app templates
  docker/       compose: postgres (platform DB), keycloak, minio, redis
  db/migrations/  platform DB (ALL metadata models); content DDL is generated
                  at runtime through providers — never shipped as migration files
```

### 2.1 DataEngineProvider abstraction — SQL + NoSQL from day one (build FIRST — Sprint 0)

Sharefyio is not only a SQL studio. It is a **universal data platform over SQL and
NoSQL engines.**

Nothing above the data layer may issue vendor SQL, vendor document queries, or import
a vendor SDK directly. All schema, metadata, item, permission, realtime, MCP, and flow
access goes through:

```ts
type DataEngineKind = "sql" | "nosql";

type ProjectDataMode =
  | "postgres_managed"
  | "postgres_external"
  | "nosql_managed"
  | "nosql_external";

// Composed of focused sub-providers — keeps each contract small as the
// surface grows (a single flat interface would hit 50+ methods).
interface DataEngineProvider {
  kind: DataEngineKind;
  capabilities(): ProviderCapabilities;
  testConnection(input: ConnectionConfig): Promise<ConnectionTestResult>;
  schema: SchemaProvider;
  items: ItemProvider;
  aggregate: AggregateProvider;
  realtime?: RealtimeProvider;
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
}

interface SchemaProvider {
  introspect(input: IntrospectionInput): Promise<IntrospectionResult>;
  migrateSystemSchema(input: MigrationInput): Promise<void>;
  // Safe Schema Change (§1.1): EVERY schema mutation goes plan() → apply(plan).
  // plan() returns: affected collections/fields, affected record counts,
  // destructive-change warnings, generated DDL / provider operation plan,
  // dry-run result, rollback snapshot reference. apply() refuses a stale plan
  // (schema hash mismatch). Unsafe fast-apply is a per-project owner opt-in.
  planChange(input: SchemaChangeInput): Promise<SchemaChangePlan>;
  applyChange(plan: SchemaChangePlan): Promise<AppliedChange>;   // snapshot + undo meta
  rollback(change: AppliedChangeRef): Promise<void>;             // one-click restore
  createCollection(input: CreateCollectionInput): Promise<CollectionDef>;
  updateCollection(input: UpdateCollectionInput): Promise<CollectionDef>;
  deleteCollection(input: DeleteCollectionInput): Promise<void>;
  createField(input: CreateFieldInput): Promise<FieldDef>;
  updateField(input: UpdateFieldInput): Promise<FieldDef>;
  deleteField(input: DeleteFieldInput): Promise<void>;
  ensureIndexes(input: EnsureIndexesInput): Promise<void>;
}

interface ItemProvider {
  list(input: ListItemsInput): Promise<PaginatedItems>;
  get(input: GetItemInput): Promise<Item>;
  create(input: CreateItemInput): Promise<Item>;
  update(input: UpdateItemInput): Promise<Item>;   // optimistic concurrency
  delete(input: DeleteItemInput): Promise<void>;
}

interface AggregateProvider {
  aggregate(input: AggregateInput): Promise<AggregateResult>;
}

interface RealtimeProvider {
  subscribe(input: RealtimeSubscribeInput): AsyncIterable<RealtimeEvent>;
}
```

Provider implementations:

```
packages/data-engine/providers/postgres
packages/data-engine/providers/nosql
```

**Hard vendor-neutrality rule:**
- Only `packages/data-engine/providers/nosql/**` may import the concrete NoSQL SDK.
- No vendor name in UI, docs, routes, SDK names, env vars, OpenAPI, emails, or errors.
- User-facing terms: **NoSQL Store, Document Store, Data Engine.**
- Follow-on SQL engines (`MySQLProvider`, `SQLServerProvider`, `CockroachProvider`)
  are additional `kind: "sql"` providers — additions, not rewrites.

**NoSQL document model.** For NoSQL projects, collections are logical document
collections. Every document carries server-owned metadata:

```json
{
  "_id": "string",
  "_sf_projectId": "string",
  "_sf_collection": "string",
  "_sf_status": "draft | published | archived",
  "_sf_createdAt": "string",
  "_sf_updatedAt": "string",
  "_sf_createdBy": "string | null",
  "_sf_updatedBy": "string | null",
  "_sf_version": 1,
  "_sf_locale": "optional",
  "_sf_parentId": "optional"
}
```

Rules: `_sf_*` fields are reserved and server-owned; user fields may never start with
`_sf_`; NoSQL updates use optimistic concurrency via `_sf_version` (or CAS-equivalent);
**cross-project isolation is enforced by `_sf_projectId` on every query.**

**Metadata storage — SINGLE SOURCE OF TRUTH: platform PostgreSQL.** ALL Sharefyio
metadata lives in the platform PG database, keyed by `project_id` — regardless of the
project's data engine:

```
Platform PG — plain Prisma models, project_id-scoped (NOT _sf_-prefixed;
the _sf_ prefix exists ONLY on server-owned fields inside content documents):
  Project, Connection,
  Collection, Field, Relation, Permission, Role, Policy, Token,
  Flow, Revision, File, Comment, Preset, Dashboard, Page, Block
```

The data engine stores **content only** (rows/documents). There are NO metadata
tables or collections of any kind inside customer databases — no `_sf_*` tables in
SQL projects, no `_sf_meta_*` collections in NoSQL projects. Consequences (this is
the point):

- The Studio, SchemaRegistry, permission compiler, flows, website builder, and MCP
  are **completely provider-independent** — no `if (provider === 'sql')` branches in
  any screen or service. Providers are reached only for content I/O and schema DDL.
- Providers receive collection/field definitions as **inputs** (from SchemaRegistry);
  they never own them.
- BYO databases stay clean: Sharefyio writes only the user's actual content tables
  (SQL) or documents (NoSQL) — nothing else.
- Project export = platform-PG metadata dump + content dump; clone/migrate between
  engines becomes feasible.
- High-volume metadata (`revisions`, `comments`, `files`) is still platform PG, but
  partitioned by `project_id` with the retention job from day one.
- Trade-off to accept: introspection drift (someone edits a BYO database directly) is
  reconciled by a scheduled `introspect()` diff job that surfaces drift in the Studio.

The Studio, SDK, REST API, MCP server, flows, website builder, and app templates must
behave **identically** across SQL and NoSQL projects.

**Filter AST is mandatory.** Upper layers never send SQL or vendor query syntax:

```ts
type FilterNode =
  | { op: "and"; children: FilterNode[] }
  | { op: "or"; children: FilterNode[] }
  | { op: "not"; child: FilterNode }
  | { field: string;
      operator: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
        | "contains" | "starts_with" | "ends_with"
        | "in" | "nin" | "null" | "not_null" | "between";
      value?: unknown };
```

Compiled separately inside providers: `PostgresFilterCompiler`, `NoSqlFilterCompiler`.
RBAC row permissions, Studio filters, REST filters, SDK filters, flows, insights,
realtime subscriptions, and MCP queries all use this same AST.

**NoSQL index strategy.** Fields/collections carry index metadata
(`{name, fields[], unique?, sparse?, type: standard|text|geo}`); marking a field
`filterable | sortable | unique | searchable | geo` makes the NoSQL provider create or
update the required index. Index planner screen later; backend support now.

**NoSQL relations.** `reference_one` (foreign id), `reference_many` (id array),
`embedded_one` (nested object), `embedded_many` (nested array), and
**`parent_child`** (tree: `_sf_parentId` + materialized path/depth fields, with
subtree/ancestor queries in the ItemProvider — required for Pages, Navigation,
Categories, and threaded Comments). Roadmap (post-v1, design the AST to not preclude
them): `polymorphic` (one field referencing multiple collections) and graph-style
many-to-many traversal. V1 population happens in the Sharefyio API layer, not via
database-native joins.

**Provider conformance tests.** One shared suite —
`packages/data-engine/test/provider-contract.spec.ts` — run against every provider:
create collection/field/item, list, filter, sort, update, optimistic conflict, delete,
field permission, row permission, public default-deny, cross-project isolation,
revision restore, relation populate, realtime event, MCP read dry-run, MCP write
permission denied, **schema plan→apply→rollback (destructive change restored
losslessly), stale-plan rejection, MCP field masking, MCP explain-plan on bulk write,
MCP approval-queue gate**. **No feature is accepted unless both PostgreSQL and NoSQL
providers pass the same contract suite.**

### 2.2 Platform services

- **Platform DB (Prisma):** Workspace, WorkspaceMember, Project, ProjectConnection
  (encrypted connection string, provider type, mode managed|external),
  Plan/Subscription/Usage, AuditLog, AppBuild, FunctionWorker.
- **Auth:** Keycloak, one realm per workspace (`sf-<slug>`). Static API tokens +
  preview tokens as specced.
- **Files:** MinIO (managed) + storage-adapter abstraction (S3/R2/GCS later).
- **Queue/runtime:** Redis + BullMQ; isolated-vm worker pool for flow scripts —
  identical design to the Basefyio function-runtime spec (§6 of the master doc).
- **Tenant isolation:** every content query runs on the project's own connection from
  an encrypted-at-rest connection registry; the platform DB never stores content.
  External-DB credentials: least-privilege role recommended at connect time; connection
  test + TLS required.

---

## 3. Feature Scope (= the two source docs, renamed)

Everything below is already fully specced in the source docs; implement as written
there with the rename mapping applied:

1. **Data model / collections** — schema-as-data + real tables, field system
   (interface/display/validation/conditions/width), relations m2o/o2m/m2m, geospatial.
   Existing-table **introspection**: wrapping a DB auto-registers supported tables
   (Directus behavior), marked `managed=false` until adopted.
2. **Content Studio** — collection page (layouts: tabular/cards/kanban/calendar/map,
   filters with AND/OR groups + dynamic variables, bookmarks, import/export), item
   editor (revisions, comments, shares rail), batch ops.
3. **Versioning** — draft-first, item-less drafts, comparison-modal publish,
   revisions + restore, retention.
4. **Translations** — translations relation pattern + studio i18n (en/tr).
5. **RBAC** — roles + policies + attachments, Public role, row/field permissions,
   tokens. (Directus-11 model, verbatim from the master doc §3.)
6. **Files** — library, metadata, `/assets` transforms.
7. **Flows** — full operation catalog on a node canvas, blocking/non-blocking event
   hooks, cron/webhook/manual triggers, executions log, retries/DLQ.
8. **APIs** — auto REST per collection, `/rest/v1` Supabase-compat alias, optional
   GraphQL, OpenAPI export, SDK generation.
9. **Live preview + visual editor**, **realtime WS**, **insights dashboards**,
   **notifications + user directory**, **project settings/appearance**.
10. **MCP server** per project — see §3.1; THE differentiator, built early (Sprint 3).
11. **AI App Builder** — analyze → AppSpec → apply → generate (KolayPhoto fixture is
    the acceptance test).

### 3.1 MCP-first (pulled forward to Sprint 3 — primary differentiator)

Claude, Cursor, Windsurf, and OpenAI clients should be able to read/write a customer's
data through Sharefyio MCP on day one of public beta. Architecture implications:

- The MCP server is a **first-class API surface**, designed alongside REST in Sprint 3
  (right after the permission compiler exists), not bolted on at the end. Every MCP
  tool call goes through the same permission compiler + audit log as REST.
- Tool surface (from the source CMS doc §11): schema introspection, query/create/
  update/delete items, files, invoke function, insights aggregate. Write tools
  dry-run by default unless the token's role grants explicit write.
- **Hard rule:** MCP tools may only call `SchemaRegistry`, `PermissionCompiler`, and
  `DataEngineProvider`. **Direct database access from MCP tool code is forbidden** —
  no SQL strings, no vendor SDK imports, no raw connections. Enforce with a lint rule
  + CI grep on the MCP module (same mechanism as the naming guard).
- **AI Data Gateway / Guardrails (§1.1):** the MCP layer is a permission firewall, not
  a wrapper. Per token: scope (collections + actions), row filters and **field masking**
  (masked fields are stripped/redacted in tool output, not just denied), dry-run-by-
  default writes, per-token rate limits, full audit log (every tool call: who/what/
  filter/result-count/diff). Destructive or bulk writes return an **explain-plan**
  (what will change, how many rows, reversibility) and — when the project enables
  approval mode — enter a **human approval queue** (Studio notification → approve/
  reject) before execution.
- Auth: role-scoped static tokens + OAuth (Keycloak); per-token rate limits.
- Marketing: "Point Claude at your database — safely" is a launch headline, with
  scoped-permission examples on the landing page.

### 3.2 Website Builder (beyond Directus/Sanity/Strapi — content + site layer; **Sprint 5**)

Competitors manage content; Sharefyio also **publishes it** — this is the layer that
answers "why not just use Directus?", so it ships EARLY (S5), not as polish. Model:

```
Collection → Page Model → Block Model → Live Preview → Publish
```

- `Page` (platform PG): route pattern (`/blog/:slug`), data binding (collection +
  filter), SEO fields, status. `Block`: typed blocks (hero, rich text, item list, item
  detail, image/gallery, form, custom embed) with props bound to collection fields;
  ordered tree per page.
- Studio gets a page composer (drag blocks, bind data, per-block style tokens) that
  reuses the item-editor field widgets and live-preview pane (version-aware).
- **Publish pipeline:** render to a Next.js (or Astro) site from `packages/app-templates`
  → deploy target: **Nfyio one-click** (default), or export (git repo / zip / Vercel /
  Netlify adapter). Published sites consume the project's public REST API with the
  Public role's permissions — the same enforcement path as everything else.

### 3.3 App Templates (early, not an afterthought)

`packages/app-templates` ships from Sprint 5, because templates are the **adoption
engine** — they turn "a studio over your DB" into "a running product":

- **Launch catalog (minimum 10):** Next.js Blog, Marketing Site, Admin Dashboard
  (generic data views over any collections), **CRM, Knowledge Base, Documentation
  Site, Directory, Job Board, E-commerce Catalog, Portfolio** — plus Astro Blog and
  Expo Mobile App as framework variants.
- Every template: typed `@sharefyio/sdk` client, env-only config, deployable to Nfyio
  or exportable, and registered as both an App Builder output target and a "Start from
  template" option at project creation (template can propose its own collections —
  template = AppSpec + frontend). Each template doubles as a contract-suite fixture
  (it must run on both SQL and NoSQL projects).

---

## 4. What stays in Basefyio (do NOT build there anymore)

Basefyio keeps: rebrand from Kolaybase, Postgres/auth/storage platform, SQL editor,
table editor, storage browser, its existing roadmap. The CMS module concept
(`Project.modules.cms`, `ModuleEnabledGuard`, `_bf_*` tables) is **cancelled** —
remove it from the Basefyio sprint plan. If a Basefyio customer wants CMS, the answer
is "connect your Basefyio database to Sharefyio."

Shared-nothing rule: no shared databases, no shared Keycloak, no cross-product imports.
Permitted sharing: copied code patterns and (optionally) published npm packages.

---

## 5. Rename Mapping (apply when copying specs)

| Source (Basefyio docs) | Sharefyio |
|---|---|
| `_bf_*` tenant tables | platform-PG Prisma models (Collection, Field, ...); `_sf_` prefix only on server-owned content-document fields |
| `bf` CLI / `bf.items()` SDK | `sf` CLI / `sf.items()` (`@sharefyio/sdk`) |
| `BASEFYIO_*` env vars | `SHAREFYIO_*` |
| `api.basefyio.com/v1/projects/:id/...` | `api.sharefyio.com/v1/projects/:id/...` |
| `X-Basefyio-Signature` | `X-Sharefyio-Signature` |
| `kb-`/`bf-` realm & bucket prefixes | `sf-` |
| `Project.modules.cms` gating | none — CMS IS the product, no module flag |
| apps/admin-ui components reuse | fresh build in apps/studio (copy patterns, not files) |

---

## 6. Sprint Plan (separate repo, solo dev + AI agents, 2-week sprints)

| Sprint | Theme | Done means |
|---|---|---|
| **S0** | Repo bootstrap + data-engine layer | Monorepo scaffold, docker compose, platform DB schema, Keycloak realm-per-workspace auth, project CRUD + connection registry (`ProjectDataMode`, managed + external w/ TLS test); **`packages/data-engine`: `DataEngineProvider` interface + `DataEngineRegistry.get(project.dataMode)` + provider contract suite**; CI with cross-tenant harness |
| **S1** | PostgresProvider + **NoSqlProvider skeleton** | `PostgresProvider` complete for collections (metadata registry in platform PG, content table generation, `introspect()`); **`NoSqlProvider`: connection test, namespace/scope creation, content collection namespace preparation, managed + external config**; data-model UI |
| **S2** | Collections/fields on **both providers** + **Safe Schema Change** | Collection + field CRUD through both providers (metadata in platform PG; reserved `_sf_` document-field prefix enforcement; document schema validation; index metadata on NoSQL); **plan→apply→rollback flow with migration-preview UI (affected records, destructive warnings, dry-run, undo snapshot)**; contract suite green for schema ops on both |
| **S3** | Items + RBAC + **MCP read on both providers** | Filter AST compilers (`PostgresFilterCompiler`, `NoSqlFilterCompiler`), items API + list/editor, drafts/status, optimistic concurrency (`_sf_version`), roles/policies/Public, permission compiler, tokens, dynamic filter variables; **MCP read tools live on SQL AND NoSQL projects with field masking + audit log, write tools dry-run — Claude/Cursor demo works on both** |
| **S4** | Files + flows core + **MCP guardrailed write** | File library + `/assets` transforms; flows with condition/run_script/CRUD/request_url/email ops; executions log; retries; **MCP write/invoke tools with role-gated permissions, explain-plan for destructive/bulk writes, human approval queue** |
| **S5** | **Website builder v1 + templates v1** | pages/blocks (platform PG) + page composer + live preview + `parent_child` tree relation (navigation/categories need it); templates: Admin Dashboard + Next.js Blog; "start from template" flow |
| **S6** | Versioning + translations + templates wave 2 | Full versioning + translations from source CMS doc (both providers); templates: Marketing Site, Knowledge Base, Documentation |
| **S7** | APIs + SDK + realtime + flows complete | OpenAPI, SDK gen, Supabase-compat alias, WS subscriptions via RealtimeProvider; full flow-operation catalog on node canvas |
| **S8** | Publish + insights + AI App Builder + templates wave 3 | **Publish to Nfyio / export (git/zip/Vercel/Netlify)**; dashboards/panels, kanban/cards/calendar layouts, notifications, user directory, settings; analyze/apply/generate; KolayPhoto fixture green; templates: CRM, Directory, Job Board, E-commerce Catalog, Portfolio, Astro Blog, Expo; security checklist pass |
| **S9** | Launch | sharefyio.com ("Data Platform" positioning; headlines: "Change your data model without breaking production" + "Let Claude work on your database safely"; 10-template gallery), docs, pricing/billing (Stripe patterns from kolaybase), onboarding ("connect a database in 60s, talk to it from Claude in 90s") |

Each sprint: e2e green → changelog → demo note → commit (Execution Guard applies; in
the new repo, set up graphify in S0 and keep it current).

---

## 7. Security & Isolation Checklist (delta over the source doc's §10)

All items from the Basefyio master §10 apply, plus external-DB specifics:

- [ ] Connection strings encrypted at rest (KMS/libsodium), never logged, never
      returned by any API after creation.
- [ ] External DBs: enforce TLS; recommend + document least-privilege role; feature
      flag to disable `run_script`/SQL ops on external connections.
- [ ] Sharefyio never creates system tables/collections in customer databases;
      content writes never touch non-managed (introspected) tables without explicit
      adoption.
- [ ] Per-workspace Keycloak realm; no cross-workspace token validity.
- [ ] Public role default-deny on introspected (non-managed) tables.
- [ ] MCP write tools require explicit role permission; dry-run default.

---

## 8. First Implementation Tasks (new repo, in order)

1. Scaffold `sharefyio` monorepo (copy kolaybase-new layout conventions), docker
   compose up with platform Postgres + Keycloak + MinIO + Redis.
2. **`DataEngineProvider` interface (sub-providers: schema/items/aggregate/realtime)
   + `PostgresProvider` skeleton + `NoSqlProvider` skeleton + provider contract
   suite** — before any feature code; everything else builds on it.
3. Platform API: Workspace/Project/ProjectConnection models + encrypted connection
   registry (`ProjectDataMode` field) + "test connection" endpoint.
4. Platform-PG metadata models (Collection/Field/Relation/...) + SchemaRegistry +
   content DDL through `SchemaProvider` (copy the relational store design from the
   source doc §3) + e2e on a scratch DB.
5. Studio shell: auth, workspace/project nav, data-model screen (collection create →
   generated SQL preview → apply).
6. Items API happy path + list view; then MCP read tools (S3 target: an external
   Claude client queries a project). From here, follow the sprint table.

---
---

# Sharefyio NoSQL Data Engine Addendum

> Apply AFTER the master prompt above. **Integration note:** master §2.1
> (`DataEngineProvider`, SQL + NoSQL from day one) is the **canonical definition** of
> the provider abstraction, document model, metadata layout, Filter AST, and contract
> suite. This addendum is the detailed execution spec for the NoSQL track (Studio
> requirements, security rules, sprint-by-sprint detail). Where wording differs, §2.1
> wins; the NoSQL track's S0–S3 are already folded into the master sprint table.
>
> **v4.3:** A2/A4/A6/A7/A12/A13 have all been rewritten in place to match §2.1 — this
> addendum no longer contains any superseded text.

## Role

You are a senior platform engineer working on Sharefyio, a standalone headless CMS and
data studio. Your task is to add a **NoSQL document data plane** alongside the existing
PostgreSQL connection model.

Sharefyio must support both:

1. **SQL projects** — PostgreSQL-backed collections.
2. **NoSQL projects** — document-backed collections.

The NoSQL store must be hidden behind a vendor-neutral abstraction. Do not expose the
vendor name in UI, APIs, docs, env vars, routes, SDK names, or error messages.
User-facing language must say **NoSQL store**, **Document Store**, or **Data Engine**.

## A1. Product Goal

Sharefyio should become: *"A content studio, API layer, automation engine, and MCP
server for SQL and NoSQL data."*

A project can be created in one of these modes:

```ts
type ProjectDataMode =
  | "postgres_managed"
  | "postgres_external"
  | "nosql_managed"
  | "nosql_external";
```

PostgreSQL remains supported, but NoSQL must become a first-class runtime option.

## A2. Architecture Rule (rewritten in v4 — canonical interface lives in §2.1)

The provider abstraction is the **sub-provider composition defined in master §2.1** —
use it exactly as written there:

```ts
interface DataEngineProvider {
  kind: DataEngineKind;                  // "sql" | "nosql"
  capabilities(): ProviderCapabilities;
  testConnection(input: ConnectionConfig): Promise<ConnectionTestResult>;
  schema: SchemaProvider;      // incl. planChange/applyChange/rollback (§1.1 Safe Schema Change)
  items: ItemProvider;
  aggregate: AggregateProvider;
  realtime?: RealtimeProvider;
  transaction?<T>(fn: () => Promise<T>): Promise<T>;
}
```

Do NOT implement a flat single-interface variant. Implement two providers:

```
packages/data-engine/providers/postgres
packages/data-engine/providers/nosql
```

Only the NoSQL provider directory may import the concrete NoSQL SDK.

## A3. NoSQL Data Model

For NoSQL projects, collections are logical document collections. Each item/document
must include system metadata:

```json
{
  "_id": "string",
  "_sf_projectId": "string",
  "_sf_collection": "string",
  "_sf_status": "draft | published | archived",
  "_sf_createdAt": "string",
  "_sf_updatedAt": "string",
  "_sf_createdBy": "string | null",
  "_sf_updatedBy": "string | null",
  "_sf_version": 1,
  "_sf_locale": "optional string",
  "_sf_parentId": "optional string"
}
```

Use optimistic concurrency via `_sf_version`. Never allow user fields to start with
`_sf_`.

## A4. Metadata Storage (rewritten in v4 — single source of truth)

**All collection/field/relation/permission/flow/revision/file/comment/preset/
dashboard/page/block metadata is stored in platform PostgreSQL only** (plain Prisma
models, `project_id`-scoped — see master §2.1). The NoSQL provider stores **content
documents only**; the Postgres provider stores **content tables only**.

There are NO `_sf_meta_*` document collections and NO `_sf_*` metadata tables in any
customer database. The `_sf_` prefix exists solely on server-owned fields **inside
content documents** (A3).

The public Studio/API behavior must be identical for SQL and NoSQL projects.

## A5. Query Abstraction

Do not expose SQL or vendor-specific query syntax to the Studio. Use the Sharefyio
Filter AST everywhere:

```ts
type FilterNode =
  | { op: "and"; children: FilterNode[] }
  | { op: "or"; children: FilterNode[] }
  | { op: "not"; child: FilterNode }
  | {
      field: string;
      operator:
        | "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
        | "contains" | "starts_with" | "ends_with"
        | "in" | "nin" | "null" | "not_null" | "between";
      value?: unknown;
    };
```

Compile this AST separately: `PostgresFilterCompiler`, `NoSqlFilterCompiler`.
All REST, GraphQL, SDK, Studio filters, RBAC filters, and MCP filters must use the
same AST.

## A6. NoSQL Index Strategy

Add index definitions to the platform-PG `Field` model and collection settings:

```ts
type IndexDefinition = {
  name: string;
  fields: string[];
  unique?: boolean;
  sparse?: boolean;
  type?: "standard" | "text" | "geo";
};
```

When a user marks a field as `filterable`, `sortable`, `unique`, `searchable`, or
`geo`, the NoSQL provider should create or update the required index. Add an index
planner screen in Studio later, but implement backend support now.

## A7. Relations in NoSQL

Support these relation types:

```ts
type RelationKind =
  | "reference_one"    // stores foreign document id
  | "reference_many"   // stores array of foreign document ids
  | "embedded_one"     // nested object
  | "embedded_many"    // nested array
  | "parent_child";    // tree: _sf_parentId + materialized path/depth,
                       // subtree/ancestor queries (pages, navigation,
                       // categories, threaded comments)
```

Studio must render them like normal relations. For V1, joins/population are handled by
the Sharefyio API layer, not by the database engine.

## A8. API Compatibility

Existing APIs must continue to work:

```
GET    /v1/projects/:projectId/items/:collection
POST   /v1/projects/:projectId/items/:collection
GET    /v1/projects/:projectId/items/:collection/:id
PATCH  /v1/projects/:projectId/items/:collection/:id
DELETE /v1/projects/:projectId/items/:collection/:id
```

The client must not care whether the project is PostgreSQL or NoSQL. SDK remains:

```ts
sf.items("articles").list()
sf.items("articles").create(data)
sf.items("articles").update(id, data)
sf.items("articles").delete(id)
```

No SDK method should be named after the concrete database.

## A9. Studio Requirements

Project creation choice:

```
Data Engine:  PostgreSQL | NoSQL Document Store
Mode:         Managed | External connection
```

For NoSQL external connections: test connection; require TLS; never log credentials;
encrypt credentials at rest; show least-privilege role instructions; validate required
capabilities: document collections, secondary indexes, optimistic concurrency or
CAS-equivalent, parameterized/server-side queries, namespacing/scope equivalent.

## A10. Security Rules (hard requirements)

- NoSQL credentials encrypted at rest; no connection string returned after creation.
- No vendor-specific errors leaked to users.
- Public role default-deny. RBAC enforced before every query.
- Row permissions compile into the provider filter AST; field permissions strip fields
  both before write and after read.
- `_sf_*` fields are server-owned.
- MCP write tools require explicit permission.
- Script/flow operations disabled by default on external NoSQL connections unless
  enabled by the project owner.

## A11. Files, Flows, Realtime, MCP

All higher-level features must work against both providers: Files, Flows, Versioning,
Translations, Realtime, Insights, MCP, AI App Builder.

Implementation rule — higher-level modules may depend only on: `DataEngineProvider`,
`PermissionCompiler`, `FilterCompiler`, `SchemaRegistry`. They must not import Postgres
or NoSQL SDKs directly.

## A12. Sprint Plan (NoSQL track)

| Sprint | Scope | Done means |
|---|---|---|
| **S0** | Data Engine package | `packages/data-engine`; current PG item/collection logic moved behind `PostgresProvider`; `DataEngineRegistry.get(project.dataMode)` | existing PostgreSQL behavior still passes |
| **S1** | NoSQL provider skeleton | connection test, namespace/scope creation, content collection namespace preparation, managed + external config | a NoSQL project can be created and initialized |
| **S2** | Collections + fields | CRUD collection/field metadata, `_sf_` reserved-prefix enforcement, document schema validation | Studio can create a NoSQL collection |
| **S3** | Items API | CRUD, pagination, sorting, Filter AST compiler, optimistic concurrency via `_sf_version` | list/editor works on NoSQL |
| **S4** | RBAC | permission filters compiled to NoSQL queries, field-level permissions, Public default-deny tests, cross-project isolation tests | same RBAC suite passes for Postgres and NoSQL |
| **S5** | Relations | reference + embedded types, API-level population, Studio relation inputs | relational content modeling works |
| **S6** | Versioning + translations | revisions in the platform-PG `Revision` model, draft/published flow, item-less drafts, translation collections + locale filtering | CMS workflows match PostgreSQL behavior |
| **S7** | Flows + realtime | flows on NoSQL CRUD events, webhook/manual/cron triggers, realtime subscriptions, execution log | automations work |
| **S8** | MCP + AI App Builder | NoSQL collections via MCP tools (read/write/search, dry-run write), App Builder creates NoSQL-backed apps | AI agents operate on NoSQL projects safely |

## A13. Acceptance Tests

Create a shared provider test suite — `data-engine.provider.spec.ts` — run against
BOTH providers. Required tests: create collection, create field, create item, list
items, filter items, sort items, update item, optimistic conflict, delete item, field
permission, row permission, public role default deny, cross-project isolation,
revision restore, relation populate (incl. parent_child subtree/ancestor), realtime
event, MCP read dry-run, MCP write permission denied, **schema plan→apply→rollback
(destructive change restored losslessly), stale-plan rejection, MCP field masking,
MCP explain-plan on bulk write, MCP approval-queue gate**.

**No feature is accepted unless both providers pass the shared contract tests.**

## A14. Naming Guard

Forbidden outside the NoSQL provider directory: the concrete database vendor name,
database-specific SDK imports, vendor-specific env var prefixes, vendor-specific UI
copy, vendor-specific API routes.

Allowed user-facing words: **NoSQL store, Document Store, Data Engine, Managed NoSQL,
External NoSQL connection.**

Add a CI grep check to enforce this rule (same mechanism as the Kolaybase grep-gate in
the Basefyio master prompt).

## A15. Final Target

```
Connect PostgreSQL → Studio / API / Flows / MCP
Connect NoSQL      → Studio / API / Flows / MCP
```

One unified product experience. The user should never need to know which internal
provider is used unless they are configuring the project connection.
