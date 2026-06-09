# Master Implementation Prompt — Basefyio "Functions & Content" Layer

**Revision v3** (2026-06-06) — **SCOPE CHANGE: the CMS layer is now a separate,
independent product: Sharefyio** (see `md/SHAREFYIO_PRODUCT_PROMPT.md`, own repo, own
infra). The v2 "optional CMS module" concept (`Project.modules.cms`,
`ModuleEnabledGuard`, `_bf_*` tenant tables) is **cancelled for Basefyio** — do not
build it here.

**What remains in scope for Basefyio from this document:**
- §8 Kolaybase → Basefyio full rename (Sprint 0) — unchanged, still the first job.
- The ⛔ Critical Execution Guard and codebase facts — still valid for all Basefyio work.
- §10 security checklist items that concern the core platform.

**Sections §3–§7, §9 Sprints 1–7, and the headless-CMS companion doc now serve as the
engineering spec for Sharefyio** (copied into the new repo with the rename mapping in
SHAREFYIO_PRODUCT_PROMPT.md §5: `_bf_`→`_sf_`, basefyio→sharefyio, etc.). Keep them
here unedited as the source of record; implement them only in the `sharefyio` repo.

**Revision v2** (superseded) — headless CMS as optional per-project module;
Directus-11 RBAC; Supabase-compat `/rest/v1` alias; KolayPhoto fixture; Execution
Guard; companion headless-CMS doc.

> Feed this prompt (whole or per-sprint sections) to Claude Code running inside the
> `kolaybase-new` monorepo. It is grounded in the actual codebase: cite the real paths
> below, do not invent new top-level structure.

---

## ⛔ Critical Execution Guard (read first, applies to every session)

Before writing code, inspect the repo and confirm the referenced paths/modules exist.
If any path differs, adapt to the actual repo structure and report the discrepancy in
the commit/demo note. Do not create duplicate modules when an existing module/component
can be extended.

For every sprint slice:

1. Run `graphify query "<implementation question>"` before code search.
2. Implement migration → API → SDK → UI → test.
3. Run relevant tests.
4. Run `graphify update .`.
5. Add changelog/demo note.
6. Commit only when the vertical slice is green.

Never expose "Kolaybase" in user-facing UI, docs, API responses, OpenAPI titles,
emails, errors, screenshots, or generated app templates. Compatibility aliases may
exist internally only until Sprint 7.

---

## 0. Mission & Ground Rules

You are implementing a Directus-inspired content & functions layer as **native Basefyio
modules** inside this repo. Basefyio is the rebrand of Kolaybase.

**Positioning (hard requirement): Basefyio is NOT becoming Directus.** Basefyio stays a
Supabase-class backend platform (Postgres, auth, storage, functions, APIs) first. The
Directus-inspired capabilities ship as an **optional, per-project "Headless CMS" module**
that a project owner enables explicitly — off by default:

- Platform DB: add `modules jsonb NOT NULL DEFAULT '{}'` to the Prisma `Project` model
  (e.g. `{"cms": true}`). Gate every CMS API route with a `ModuleEnabledGuard('cms')`
  (404 when disabled) and hide all CMS UI/sidebar entries when disabled.
- Enabling the module runs the `_bf_*` tenant migrations lazily (first enable) and adds
  Content/Data Model/Files/Roles/Flows entries to the project sidebar. Disabling hides
  UI + APIs but never drops tenant data (explicit destructive "remove module data"
  action exists separately, double-confirmed).
- Projects without the module keep today's experience unchanged: table editor, SQL
  editor, storage browser, auth. Core features (storage, auth, raw SQL, existing APIs)
  must never depend on CMS tables or the module flag.
- Messaging: "Basefyio — backend platform, with an optional headless CMS module."
  Never describe Basefyio itself as a CMS or as a Directus alternative-by-default.

**Naming rules (hard requirements):**
- Product name: **Basefyio**. Domain: **basefyio.com**.
- FULL RENAME: repo packages, env vars, CLI binary, DB identifiers, and all user-facing
  strings move from Kolaybase → Basefyio (migration plan in §8 below — execute it as
  Sprint 0, with compat aliases that are removed in the final sprint).
- "Kolaybase" must never appear in user-facing UI, docs, error messages, or API responses.
- Do NOT reskin or embed Directus. Build Basefyio-native modules; Directus 11 is the UX
  reference only (content list view, item editor drawer, filter builder, flows canvas).

**Companion document:** `md/BASEFYIO_HEADLESS_CMS_PROMPT.md` — Directus-docs feature
parity layer (content versioning, translations, live preview, layouts, field
interfaces, flow operation catalog, realtime, insights, MCP server). Sprints 8–13.
Read it when the master Sprints 0–7 are done, or when implementing any feature it owns.

**Reference material in this repo (read when implementing the relevant area):**
- `md/refs/directus-ui-screenshots/` — 11 numbered JPGs of Directus 11.17.1
  (kolayphoto.directus.app); the UX ground truth for §5.
- `md/refs/kolaybase-data-api-docs.md` — Supabase PostgREST patterns + the generic
  admin data-view prompt; ground truth for the §4 Supabase-compat alias and §7
  generated-app pattern.
- `md/refs/kolayphoto-frontend-prompt.md` — full KolayPhoto frontend spec; ground truth
  for the §7 app-builder acceptance fixture.

**UX reference (from the kolayphoto.directus.app 11.17.1 screenshots — match these patterns):**
- Persistent left icon rail: Content · User Directory · File Library · Insights · Help ·
  Settings, with notifications + profile pinned bottom. Basefyio equivalent lives inside
  the project dashboard sidebar.
- Content list (`/admin/content/articles`): breadcrumb ("Content / Articles") + bookmark
  icon (saved views), item count ("One Item"), search, filter, primary `+` button;
  right rail with collapsible panels: **Layout Options, Archive, Auto Refresh,
  Import/Export**; checkbox column for batch select; status shown as colored dot.
- Item editor (`/admin/content/articles/1`): title "Editing Item in Articles" with
  back arrow; toolbar: delete, save-as-copy, save (check); **Status as the first field**
  (dropdown with colored dot, "Draft"); right rail: **Revisions (count badge), Comments,
  Shares** — plus an **AI Assistant** panel docked bottom-right (Basefyio already has
  `ai-assistant.tsx`; reuse it there).
- Data model (`/admin/settings/data-model/articles`): "Fields & Layout — Saves
  Automatically"; drag-handle field rows; **half-width fields render side-by-side**
  (e.g. `date_created` + `date_updated`); per-field eye toggle (hidden) and key icon
  (primary); "Create Field" button + "Create Field in Advanced Mode" link; below it
  "Collection Setup": collection name (readonly machine name), note, icon, color.
- Settings split: Flows, User Roles (columns: Name/Users/Child Roles/Description, with
  system rows **Public** and **Administrator**), **Access Policies** (separate screen:
  Name/Users/Roles/Description), Project Settings, Appearance (branding).
- File Library and Insights (dashboard list with Import side panel) are top-level rail
  items, not settings.

**Codebase facts (verified — build on these, do not duplicate):**
- Monorepo: `apps/admin-ui` (Next.js 14, Tailwind, shadcn/ui), `apps/platform-api`
  (NestJS + Prisma, schema at `apps/platform-api/prisma/schema.prisma`), `apps/website`,
  `packages/cli` (the `kb` binary), `packages/sdk`.
- Multi-tenant model: each Project gets its **own PostgreSQL database** and its **own
  Keycloak 24 realm**. Storage is MinIO behind a REST proxy
  (`app.*/api/proxy/projects/<PROJECT_ID>/storage/...`, requires BOTH
  `Authorization: Bearer <SERVICE_KEY>` and `apikey` headers).
- Existing platform-api modules: `ai, auth, billing, data-import, email, embedding,
  feedback, infrastructure, integrations, marketing-insights, observability, pgbouncer,
  projects, queue, realtime, recommendation, redis, search, sql, storage, stripe,
  team-integrations, teams, tenant-embedding`.
- Existing Prisma models include `User, Team, TeamMember, Project, ProjectActivityLog,
  ProjectAuthConfig, SqlAuditLog, AuditLog, Plan/Subscription/Invoice, UsageRecord,
  ProjectInfrastructure`. Roles exist as `UserRole` and `TeamMemberRole` enums.
- Existing admin-ui components to extend, not replace: `table-editor.tsx`,
  `sql-editor.tsx`, `storage-browser.tsx`, `create-table-dialog.tsx`,
  `project-detail.tsx`, `app-sidebar.tsx`.
- Data layer is **NOT PostgREST** — data access is pg-direct via a Supabase-style shim.
  The shim has no `.or()`; `.single()` returns `data:null` (not error) on no match;
  migrations are plain SQL tracked in `_migrations`.
- Knowledge graph: run `graphify query "<question>"` before grepping; run
  `graphify update .` after code changes.

**Agent working rules:**
- One vertical slice at a time: migration → API → SDK → UI → test, then commit.
- Every new endpoint gets an e2e test against a scratch project DB.
- All tenant-scoped SQL must go through the per-project connection factory — never the
  platform DB pool. Add a lint rule/test that fails if a tenant query touches platform DB.
- Update `packages/sdk` and OpenAPI export in the same PR as any API change.

---

## 1. Executive Summary

Basefyio today is a Supabase-class BaaS (per-project Postgres + Keycloak realm + MinIO,
admin UI with table/SQL/storage editors). This program adds a Directus-class layer as an
**optional per-project Headless CMS module** (off by default; the platform identity
stays "backend platform"): **Collections** (schema-as-data with auto-generated tables), a **Content UI** (list
view + item editor with drafts, filters, activity), **fine-grained RBAC** (row/field
level), **Files** with metadata and adapters, **Flows/Functions** (event/schedule/webhook
triggered JS/SQL/HTTP/AI functions with logs and retries), **auto APIs** (REST always,
GraphQL optional, OpenAPI + SDK generation), and an **AI App Builder** that goes from
intent (or an Excel sheet) → proposed schema/permissions/screens → generated web/mobile/
admin apps. Marketing language: "Basefyio flexible data engine" — never name internal
engines (Postgres JSONB or Couchbase) in customer-facing copy.

Delivery: solo dev + AI agents, 2-week sprints, ~7 sprints (§9). Sprint 0 is the full
Kolaybase→Basefyio rename. Document-collections ship on Postgres JSONB first; Couchbase
is specced behind the same `CollectionStore` interface with a go/no-go decision matrix
(§3.4) — the API contract is identical either way.

---

## 2. Product Architecture

```
┌────────────────────────────────────────────────────────────────┐
│ apps/admin-ui (Next.js)                                        │
│  existing: tables · SQL · storage     NEW: /content /flows     │
│                                            /files /roles /ai   │
└───────────────┬────────────────────────────────────────────────┘
                │ REST/JWT (Keycloak per-realm)
┌───────────────▼────────────────────────────────────────────────┐
│ apps/platform-api (NestJS) — NEW modules                       │
│  collections · items · permissions · files · flows · functions │
│  api-gen (REST/GraphQL/OpenAPI/SDK) · app-builder (AI)         │
│  existing reused: queue (BullMQ/redis) · realtime · ai ·       │
│  storage · sql · projects · auth                               │
└──┬──────────────┬──────────────┬──────────────┬────────────────┘
   │              │              │              │
┌──▼─────────┐ ┌──▼──────────┐ ┌─▼──────────┐ ┌─▼───────────────┐
│ Platform DB│ │ Per-project │ │ MinIO      │ │ Function runtime│
│ (Prisma)   │ │ Postgres    │ │ (files)    │ │ isolated-vm /   │
│ control-   │ │ data +      │ │            │ │ worker pool     │
│ plane only │ │ _bf_* meta  │ │            │ │ (queue module)  │
└────────────┘ └─────────────┘ └────────────┘ └─────────────────┘
```

**Key decisions:**
1. **Metadata lives in the tenant DB, not the platform DB.** Collection/field/permission
   definitions are rows in `_bf_*` system tables inside each project's own Postgres
   database. This preserves the existing isolation model (one DB per project), makes
   project export/clone trivial, and keeps the platform DB control-plane only
   (projects, billing, teams).
2. **Schema-as-data + real tables.** A relational collection = a `_bf_collections` row +
   a real Postgres table generated by migration. Directus does the same; it keeps raw SQL
   and the existing `sql-editor` fully usable on content tables.
3. **`CollectionStore` interface** with two implementations: `RelationalStore` (real
   tables) and `DocumentStore` (JSONB v1, Couchbase candidate later). Items API and
   permissions sit above this interface — callers cannot tell which engine serves them.
4. **Functions run out-of-process** via the existing `queue` (Redis/BullMQ) module and a
   worker pool using `isolated-vm` (per-execution memory/CPU/time limits). No tenant code
   ever runs in the API process.
5. **Reuse, don't fork:** triggers publish through the existing `realtime` module; AI
   functions and the app builder call through the existing `ai` module; file uploads ride
   the existing `storage` module + MinIO proxy.

---

## 3. Data Model

### 3.1 Tenant-DB system tables (plain SQL migrations, `_bf_` prefix, idempotent)

```sql
-- 001_bf_meta.sql
CREATE TABLE IF NOT EXISTS _bf_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,            -- machine name = table name for relational
  display_name text NOT NULL,
  icon text, note text,
  store text NOT NULL DEFAULT 'relational',  -- 'relational' | 'document'
  is_system boolean NOT NULL DEFAULT false,
  status_field boolean NOT NULL DEFAULT true, -- draft/published enabled
  sort_field text, archive_field text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS _bf_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES _bf_collections(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,        -- text|number|boolean|date|datetime|enum|json|relation|file
  required boolean NOT NULL DEFAULT false,
  unique_ boolean NOT NULL DEFAULT false,
  default_value jsonb,
  options jsonb NOT NULL DEFAULT '{}',  -- enum choices, relation target, file kinds,
                                        -- ui widget, validation rules
  relation jsonb,            -- {collection, type: m2o|o2m|m2m, junction?}
  sort int NOT NULL DEFAULT 0,
  hidden boolean NOT NULL DEFAULT false,
  UNIQUE (collection_id, name)
);

-- Directus-11-style RBAC: permissions belong to POLICIES; policies attach to roles
-- (and optionally directly to users/tokens). Roles support hierarchy (child roles).
CREATE TABLE IF NOT EXISTS _bf_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,            -- public|admin|developer|editor|viewer + custom
  description text,
  parent_id uuid REFERENCES _bf_roles(id),   -- child roles inherit parent policies
  is_system boolean NOT NULL DEFAULT false
);
-- 'public' is a real role: it defines what unauthenticated API requests may read.

CREATE TABLE IF NOT EXISTS _bf_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  admin_access boolean NOT NULL DEFAULT false,
  app_access boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS _bf_policy_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES _bf_policies(id) ON DELETE CASCADE,
  role_id uuid REFERENCES _bf_roles(id) ON DELETE CASCADE,
  user_id text,                         -- direct user attachment (Keycloak sub)
  sort int NOT NULL DEFAULT 0,
  CHECK (role_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS _bf_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES _bf_policies(id) ON DELETE CASCADE,
  collection text NOT NULL,
  action text NOT NULL,                 -- create|read|update|delete|share
  row_filter jsonb,                     -- Directus-style filter AST, null = all rows
  field_allowlist text[],               -- null = all fields
  validation jsonb,                     -- write-time payload constraints
  UNIQUE (policy_id, collection, action)
);
-- Effective permissions = union of all policies reachable via user → role →
-- parent-role chain → attachments. Compiler memoizes per (user, collection, action).

CREATE TABLE IF NOT EXISTS _bf_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection text NOT NULL, item_id text NOT NULL,
  user_id text NOT NULL, comment text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_bf_comments_item ON _bf_comments(collection, item_id);

CREATE TABLE IF NOT EXISTS _bf_presets (    -- saved views / bookmarks (list screens)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection text NOT NULL,
  user_id text,                          -- null = shared with role
  role_id uuid REFERENCES _bf_roles(id),
  name text,                             -- named bookmark; null = user's last state
  layout jsonb NOT NULL DEFAULT '{}'     -- columns, widths, sort, filter, search, page size
);

CREATE TABLE IF NOT EXISTS _bf_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,      -- store hash only; show token once
  role_id uuid NOT NULL REFERENCES _bf_roles(id),   -- token inherits role's policies
  expires_at timestamptz,
  last_used_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS _bf_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection text NOT NULL,
  item_id text NOT NULL,
  action text NOT NULL,                 -- create|update|delete|publish|revert
  user_id text, token_id uuid,
  delta jsonb,                          -- changed fields: {field: [old, new]}
  snapshot jsonb,                       -- full row for revert
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bf_activity_item ON _bf_activity(collection, item_id);

CREATE TABLE IF NOT EXISTS _bf_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket text NOT NULL, storage_key text NOT NULL,
  filename text NOT NULL, title text,
  mime_type text NOT NULL, size_bytes bigint NOT NULL,
  width int, height int, duration_s numeric,
  metadata jsonb NOT NULL DEFAULT '{}',
  folder text, uploaded_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, storage_key)          -- bucket column is required: key alone not unique
);

CREATE TABLE IF NOT EXISTS _bf_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, description text,
  trigger jsonb NOT NULL,   -- {type: event|schedule|webhook|manual,
                            --  event?: {collection, actions[]}, cron?, webhook?: {method}}
  status text NOT NULL DEFAULT 'active',     -- active|paused
  steps jsonb NOT NULL DEFAULT '[]',         -- ordered [{function_id, input_map, on_error}]
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS _bf_functions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  type text NOT NULL,                   -- js|sql|http|ai
  code text,                            -- js source | sql text
  config jsonb NOT NULL DEFAULT '{}',   -- http: {url,method,headers}; ai: {model,prompt}
  input_schema jsonb, output_schema jsonb,   -- JSON Schema
  timeout_ms int NOT NULL DEFAULT 10000,
  retry jsonb NOT NULL DEFAULT '{"max":3,"backoff":"exponential"}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS _bf_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id uuid, function_id uuid NOT NULL,
  trigger jsonb, input jsonb, output jsonb,
  status text NOT NULL,                 -- queued|running|success|failed|retrying|dead
  attempt int NOT NULL DEFAULT 1,
  error text, logs jsonb NOT NULL DEFAULT '[]',
  started_at timestamptz, finished_at timestamptz, duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bf_exec_flow ON _bf_executions(flow_id, created_at DESC);

-- DocumentStore v1 (JSONB engine)
CREATE TABLE IF NOT EXISTS _bf_documents (
  collection text NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  data jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS idx_bf_documents_gin ON _bf_documents USING gin (data jsonb_path_ops);
```

### 3.2 Generated content tables (relational store)

Creating a collection `articles` with status enabled generates a migration:

```sql
CREATE TABLE IF NOT EXISTS articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft',      -- draft|published|archived
  sort int,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
  -- + one column per _bf_fields row; relations: m2o = FK column,
  --   o2m = FK on target, m2m = generated junction table articles_tags
);
```

Field-type → column mapping: text→`text`, number→`numeric`/`int` (option), boolean→
`boolean`, date→`date`/`timestamptz`, enum→`text` + CHECK constraint, json→`jsonb`,
relation m2o→`uuid REFERENCES`, file→`uuid REFERENCES _bf_files(id)`.

All schema changes append numbered SQL files to the project's `_migrations` flow —
destructive changes (drop column, narrow type) require an explicit `?confirm=` flag and
write a `_bf_activity` entry.

### 3.3 Platform-DB additions (Prisma)

Only control-plane state: `model FunctionWorker` (worker pool registry/health) and
`model AppBuild` (AI app-builder jobs: project, spec snapshot, status, artifacts URL).
Everything else stays tenant-side.

### 3.4 Document store: JSONB now, Couchbase decision later

Both engines implement:

```ts
interface CollectionStore {
  list(c, q: Query): Promise<Page<Item>>;     // filters, sort, pagination, search
  get(c, id): Promise<Item | null>;
  create(c, data, ctx): Promise<Item>;
  update(c, id, patch, ctx): Promise<Item>;
  delete(c, id, ctx): Promise<void>;
  ensureIndexes(c, fields): Promise<void>;
}
```

| Criterion | Postgres JSONB (v1) | Couchbase (candidate) |
|---|---|---|
| Ops burden | zero new infra | new cluster, backups, upgrades |
| Tenant isolation | inherits DB-per-project | needs scope/bucket-per-project + RBAC work |
| Query power | SQL + GIN, joins to relational data | N1QL, no cross-engine joins |
| Scale ceiling | fine to ~10⁷ docs/project | better at very large/document-heavy loads |
| Flexible schema | yes | yes |
| Offline/mobile sync | no | Couchbase Lite/Sync Gateway — the real differentiator |

**Decision gate (end of Sprint 4):** adopt Couchbase only if (a) a concrete customer
needs mobile sync or >10⁷-doc collections, AND (b) tenant isolation design (scope per
project, per-scope creds) passes the §10 checklist. Otherwise stay JSONB. Customer-facing
name in both cases: **"flexible collections" / "Basefyio flexible data engine"**.

---

## 4. API Design

All tenant data APIs are served per-project, authenticated by Keycloak JWT (realm of the
project) **or** `_bf_tokens` static token. Base:
`https://api.basefyio.com/v1/projects/:projectId` (alias kept on the app proxy).

```
# Collections (meta)
GET/POST           /collections
GET/PATCH/DELETE   /collections/:name
GET/POST           /collections/:name/fields
PATCH/DELETE       /collections/:name/fields/:field

# Items (auto REST per collection — both stores)
GET    /items/:collection           ?filter=<json>&sort=-created_at&page=2&limit=25
                                    &search=...&fields=title,author.name&status=published
POST   /items/:collection           (single or array)
GET    /items/:collection/:id       ?fields=...&deep=...
PATCH  /items/:collection/:id
DELETE /items/:collection/:id
GET    /items/:collection/:id/activity
POST   /items/:collection/:id/revert/:activityId
GET/POST /items/:collection/:id/comments      PATCH/DELETE /comments/:id
POST   /items/:collection/import              -- csv/json/xlsx via data-import module
GET    /items/:collection/export?format=csv|json|xlsx   -- respects current filter
GET/POST /presets    PATCH/DELETE /presets/:id          -- saved views/bookmarks

# Filter AST (Directus-compatible operators)
{"_and":[{"status":{"_eq":"published"}},{"author":{"name":{"_contains":"ş"}}}]}
Operators: _eq _neq _lt _lte _gt _gte _in _nin _null _nnull _contains _icontains
           _starts_with _between _and _or

# Files
POST   /files                       multipart, field `file`; reuse storage proxy contract
GET    /files /files/:id            DELETE /files/:id   PATCH /files/:id (metadata)
GET    /assets/:id?width=&height=&fit=    -- transform via sharp, cache to MinIO

# Roles, policies & permissions (Directus-11 model)
GET/POST /roles        GET/PATCH/DELETE /roles/:id     -- incl. parent_id (child roles)
GET/POST /policies     GET/PATCH/DELETE /policies/:id
POST/DELETE /policies/:id/attachments               -- attach to role or user
GET/POST /permissions  PATCH/DELETE /permissions/:id  -- belong to a policy
GET    /permissions/me/:collection                   -- effective compiled permissions
GET/POST /tokens       DELETE /tokens/:id             -- token value returned once

# Functions & flows
GET/POST /functions    GET/PATCH/DELETE /functions/:id
POST   /functions/:id/invoke         -- validated against input_schema
GET/POST /flows        GET/PATCH/DELETE /flows/:id
POST   /flows/:id/trigger            -- manual run
POST   /hooks/:flowId/:secret        -- webhook trigger (unauthenticated path, secret-gated)
GET    /executions ?flow=&status=    GET /executions/:id   (logs incl.)

# API generation
GET    /openapi.json                 -- generated from _bf_collections + _bf_fields
POST   /sdk/generate                 -- {target: ts|react|react-native|flutter} → artifact
POST   /graphql                      -- optional, behind project setting (Sprint 6)

# Supabase-compat alias (Sprint 6) — lets @supabase/supabase-js point at Basefyio
GET/POST/PATCH/DELETE  /rest/v1/:collection     -- PostgREST query syntax
                                    ?select=*,author(*)&status=eq.published
                                    &order=created_at.desc  + Range header pagination
POST   /rest/v1/rpc/:fn             -- invokes a Basefyio SQL function by name
Translate PostgREST operators (eq,neq,gt,gte,lt,lte,like,ilike,is,in,cs,cd,or,not)
into the internal filter AST; enforce the SAME permission compiler. This gives every
generated frontend (and existing Supabase tooling) a drop-in data API.

# AI app builder
POST   /app-builder/analyze          -- {intent | xlsx upload} → proposed spec
POST   /app-builder/apply            -- spec → collections, roles, permissions, flows
POST   /app-builder/generate         -- {targets:[web,mobile,admin]} → AppBuild job
GET    /app-builder/builds/:id
```

**Error envelope:** `{errors:[{code, message, field?}]}`. Codes: `FORBIDDEN`,
`NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT`, `RATE_LIMITED`, `EXECUTION_FAILED`.
**Every request** resolves `(user|token) → role → permissions` and compiles `row_filter`
into a SQL WHERE / JSONB predicate **inside** the store layer — there is no code path to
items that bypasses the permission compiler.

`packages/sdk` gains typed clients: `bf.items('articles').list({filter, sort})`,
`bf.files.upload()`, `bf.functions.invoke()`, generated collection types via `kb gen`
(renamed `bf gen`).

---

## 5. UI Screens (apps/admin-ui, Directus 11 as UX reference)

New routes under `app/dashboard/projects/[id]/` — ALL rendered only when the project's
CMS module is enabled (`Project.modules.cms`); otherwise the sidebar and routes don't
exist. A "Modules" card in project settings hosts the enable/disable toggle:

1. **`/content`** — collection nav (left rail, grouped, icons from `_bf_collections.icon`).
2. **`/content/[collection]`** — Directus-style list (match screenshot 1): breadcrumb +
   bookmark star (saved views from `_bf_presets`), item count, search, filter builder
   mapping 1:1 to the filter AST, primary `+` create button; server-driven columns
   (show/hide/reorder, persisted to `_bf_presets`), sort by header, pagination
   (25/50/100), checkbox batch select → batch edit/delete/status-change, status as
   colored dot/chip (draft=amber, published=green, archived=gray); collapsible right
   rail: **Layout Options, Archive (show archived toggle), Auto Refresh,
   Import/Export** (wired to the import/export endpoints). Reuse table primitives from
   `table-editor.tsx`.
3. **`/content/[collection]/[id]`** — item editor (match screenshot 2): back arrow +
   "Editing Item in <Collection>" header; toolbar: delete, save-as-copy, save; **Status
   dropdown as first field**; field widgets per type (enum=select, relation=searchable
   dropdown with inline-create, file=upload/pick from library, json=code editor;
   half-width fields render side-by-side per field `options.width`). Right rail:
   **Revisions** (count badge, diff view + revert from `_bf_activity`), **Comments**
   (`_bf_comments`, @mentions later), **Shares** (post-v1 stub), and the existing
   **AI Assistant** panel docked bottom-right.
4. **`/data-model`** — collection builder (match screenshot 3): "Fields & Layout —
   Saves Automatically"; drag-handle rows with width control (half-width pairs
   side-by-side), per-field hidden-eye and primary-key icons; "Create Field" +
   "Create Field in Advanced Mode" (full options: validation, default, interface,
   conditions); "Collection Setup" below: readonly machine name, note, icon, color,
   store type shown as "Standard" vs "Flexible"; relation wizard (m2o/o2m/m2m with
   junction preview); generated-SQL preview before apply.
5. **`/files`** — extend `storage-browser.tsx`: grid with thumbnails, folder tree,
   metadata panel, image preview with transform URL copy, video/document preview.
6. **`/roles` + `/policies`** — two screens like Directus 11 (screenshots 5–6). Roles
   list: Name / Users / Child Roles / Description, with system rows **Public** (defines
   unauthenticated API access) and **Administrator**. Policies list: Name / Users /
   Roles / Description; policy detail = permission matrix (collections × CRUD) with
   tri-state cells (all / custom / none); custom opens row-filter builder + field
   checklist + validation rules. Attach policies to roles or directly to users. Token
   management screen (create → show once → list with last-used).
7. **`/flows`** — flow list with status + last-run; flow editor: trigger config panel +
   vertical step list (v1; node canvas later), per-step function picker and input
   mapping (`{{ $trigger.payload.id }}` template syntax). Execution log table with
   expandable per-step logs, retry button, dead-letter filter.
8. **`/functions`** — function list; editor with Monaco (JS/SQL), input/output JSON
   Schema editors, test-invoke panel with sample payload.
9. **`/app-builder`** — wizard: intent textarea or .xlsx upload → AI-proposed schema
   review (editable cards: collections, relations diagram, roles, screens, flows) →
   apply → generate targets → build status → artifact download / preview link.
10. **Post-v1 (specced, not sprint-planned):** User Directory per project (screenshot 9 —
    list Keycloak realm users with role assignment), Insights dashboards (screenshot 11 —
    saved dashboard list with panels over collection aggregates), item Shares (public
    expiring links to single items), Appearance/branding per project (screenshot 8).
11. **Rebrand pass** — logo, product name, page titles, emails, error pages, changelog:
    Basefyio everywhere. `app-sidebar.tsx` gains Content, Data Model, Files, Roles,
    Flows, App Builder entries (mirroring the Directus left rail order).

---

## 6. Function Runtime

**Execution path:** trigger (item event from store layer hooks / cron via queue
scheduler / webhook route / manual) → enqueue `bf-exec` job (BullMQ, existing `queue`
module) → worker pool picks up → run → write `_bf_executions` → publish progress on
existing `realtime` channel `project:<id>:executions`.

**Per type:**
- **JS/TS:** `isolated-vm` isolate, 128 MB memory, CPU-time capped, `timeout_ms`
  enforced. Injected API surface only: `bf.items` (permission-checked, runs as the
  flow's configured role — never implicit admin), `bf.files`, `bf.http` (egress
  allow-list per project, no RFC1918/metadata IPs), `bf.log`, `bf.env` (project secrets
  via existing `secrets`). No `require`, no fs, no raw net. TS transpiled at save time.
- **SQL:** runs on the project DB under a dedicated `bf_function_<project>` Postgres role
  whose grants are derived from the function's configured role; statement_timeout set;
  single statement or DO block; result rows → output.
- **HTTP webhook:** outbound fetch with same egress policy, HMAC signature header
  (`X-Basefyio-Signature`), configurable retries on 5xx/timeout.
- **AI:** calls existing `ai` module; config = model + prompt template (inputs
  interpolated), output validated against `output_schema` (JSON mode), token usage
  recorded to `UsageRecord` for billing.

**Reliability:** retries per function `retry` config (exponential backoff via BullMQ),
then dead-letter status `dead` with alert through existing notifications. Executions are
idempotency-keyed (`flow_id + trigger hash`) to absorb duplicate event delivery. Logs are
structured `[{ts, level, msg}]`, truncated at 1 MB, retained 30 days (configurable per
plan).

**Event emission:** the store layer (both engines) emits `item.created|updated|deleted`
with `{collection, id, delta, actor}` AFTER commit; flow matching is indexed by
`(collection, action)`. Schedule triggers register BullMQ repeatable jobs; webhook
triggers mint a per-flow secret path.

---

## 7. AI App-Generation Flow (APEX-spirit, Basefyio-native)

1. **Ingest:** intent text, or .xlsx via existing `data-import` module (sheets → inferred
   collections, columns → field types, repeated values → enums, cross-sheet lookups →
   relations). Excel add-in posts the same payload to `/app-builder/analyze`.
2. **Analyze (AI module):** produce a single reviewable `AppSpec` JSON:
   `{collections[], relations[], roles[], permissions[], screens[], flows[], seed_data?}`.
   Deterministic JSON-schema-validated output; the model proposes, never applies.
3. **Review:** user edits the proposal in the §5.9 wizard. Nothing touches the project
   until "Apply".
4. **Apply:** transactional — create collections/fields (generating migrations), roles,
   permissions, flows; import seed rows; every step logged to `_bf_activity`.
5. **Generate:** `AppBuild` job renders from templates in a new `packages/app-templates`:
   - **web**: Next.js app consuming `packages/sdk` typed client,
   - **mobile**: React Native (Expo) from the same screen spec,
   - **admin**: configuration of the built-in Content UI (no codegen needed).
   Output: downloadable repo archive + optional deploy hook. Builds are reproducible
   from the stored spec snapshot.
6. **Iterate:** user re-prompts ("add an approvals step") → diff against current spec →
   only the delta is proposed for apply.

**Generated web/admin apps follow the proven generic data-view pattern** (from the
kolaylinks admin prompt): sidebar grouped by domain; one reusable per-collection data
view (server-side sort/range pagination, columns dropdown, filter bar = column +
operator + value, row actions view/edit/delete with confirm, toolbar insert/refresh/
export); forms generated from field metadata (required/type/format → widget: uuid=text,
int=number, boolean=toggle, timestamptz=datetime picker); a Functions page rendering an
argument form per function and showing the JSON result; toasts surfacing
`error.message`; graceful 401/403 handling. Generated apps consume the Supabase-compat
`/rest/v1` alias via `@supabase/supabase-js` or the typed Basefyio SDK.

**Worked example — acceptance test for the whole pipeline (KolayPhoto):**
Input intent: "AI-ready stock photo platform: free photos from Wikimedia Commons +
user uploads; contributors earn KolayMiles via x402 AI micropayments; moderation before
publish; dark theme, blue (#4d8dff) accent."
Expected `AppSpec` the builder must produce (use as the canonical e2e fixture):
- Collections: `photos` (title, description, file/image, category m2o, tags, license
  enum [CC0, CC BY 4.0, CC BY-SA 4.0, CC BY-NC 4.0], ai_safe boolean, source enum
  [user_upload, wikimedia], status draft/pending/published), `categories`,
  `contributors` (profile + wallet), `miles_transactions` (x402 payment ledger),
  `download_events`.
- Roles/policies: Public (read published+ai_safe-filterable photos only), Contributor
  (CRUD own photos → status pending), Moderator (approve/reject pending), Admin.
- Flows: on photo create → moderation queue + notify; on approve → status published +
  notify contributor; on AI download event → webhook (x402) → create miles_transaction
  → AI function tags/captions image.
- Screens (web target): landing (hero, stats band, 3 feature cards), `/photos/search`
  (filter panel: source, category, AI-safe; grid; empty state), `/photos/[id]` (preview,
  metadata, license/attribution, source + AI-safe badges, download + miles info),
  `/upload` (dropzone, details form, license picker, moderation notice), `/profile`
  (own photos + miles wallet), auth (login with magic link, signup).
The pipeline passes when analyze→apply→generate yields a running app matching this spec
without manual schema edits.

---

## 8. Kolaybase → Basefyio Migration Plan (FULL rename — Sprint 0)

Order matters; each step ships with a compat alias, aliases removed in Sprint 7.

1. **Domains:** stand up `app|api|db|auth|storage.basefyio.com`; 301/CNAME from
   kolaybase.com equivalents; Keycloak issuer URLs: add basefyio issuer, keep old issuer
   accepted during transition (dual-issuer JWT validation), then cut over.
2. **Env vars:** introduce `BASEFYIO_*`; config loader reads `BASEFYIO_*` first, falls
   back to `KOLAYBASE_*` with a deprecation warning. `bf link` writes only `BASEFYIO_*`.
3. **CLI:** publish `basefyio-cli` exposing `bf`; `kb` ships as alias binary printing a
   rename notice. `kolaybase-cli` final version = wrapper that installs the new package.
4. **Packages/SDK:** publish under new npm scope; old packages get a final
   re-export-only release marked deprecated.
5. **Code identifiers:** repo-wide rename (`Kolaybase*` classes, `kb-` realm prefix →
   keep existing realms as-is [renaming Keycloak realms is breaking]; new projects get
   `bf-<slug>` realms; realm-prefix is config, not hardcoded).
6. **MinIO buckets:** existing `kb-<slug>-<bucket>` names stay (S3 renames are copies);
   new buckets `bf-<slug>-<bucket>`; bucket-name resolution reads from project record,
   never derives from slug at call sites.
7. **User-facing strings:** admin-ui, website, transactional emails, error envelopes,
   OpenAPI titles — grep-gate in CI: build fails if `/kolaybase/i` appears outside
   `legacy/` paths and the migration-notes doc.
8. **DB identifiers:** platform DB name/users renamed at a maintenance window; tenant
   DBs untouched (internal only).

---

## 9. Sprint Plan (solo dev + AI agents, 2-week sprints)

| Sprint | Theme | Done means |
|---|---|---|
| **0** | Rebrand + foundations | §8 steps 1–4,7 done; `Project.modules` flag + `ModuleEnabledGuard('cms')` + module toggle in project settings; `_bf_` migration runner for tenant DBs (runs on first enable); `CollectionStore` interface + permission-compiler skeleton with tests |
| **1** | Collections + relational store | Data-model UI (§5.4); field builder all types except relation; table generation + migrations; collections/fields API; `bf gen` types |
| **2** | Items API + Content UI | Filter AST compiler; list view + item editor (§5.2–5.3); drafts/status; activity log + revert; comments; saved views (presets); import/export; relations (m2o/o2m/m2m) |
| **3** | RBAC + tokens | Roles + policies + attachments (Directus-11 model incl. Public role & child roles); permission matrix UI; row/field-level enforcement in store layer (test: zero bypass paths); static tokens; per-role rate limits |
| **4** | Files + flexible collections | `_bf_files` + library UI; asset transform endpoint; DocumentStore on JSONB end-to-end; **Couchbase go/no-go review (§3.4)** |
| **5** | Functions + flows | isolated-vm worker pool; JS/SQL/HTTP/AI function types; event/cron/webhook/manual triggers; executions log UI; retries + DLQ |
| **6** | Auto APIs + SDK | OpenAPI export; SDK generation (ts/react/react-native); **Supabase-compat `/rest/v1` + `/rpc` alias**; optional GraphQL endpoint; docs site section on basefyio.com |
| **7** | AI App Builder + polish | analyze/apply/generate pipeline; Excel add-in path; **KolayPhoto fixture passes end-to-end (§7)**; remove all Kolaybase compat aliases; security pass against §10 checklist |

Each sprint ends with: e2e suite green, `graphify update .`, changelog entry, demo
script.

---

## 10. Security & Tenant-Isolation Checklist (gate for Sprints 3, 5, 7)

- [ ] All CMS endpoints return 404 when `Project.modules.cms` is disabled — CI test
      hits every CMS route on a module-disabled project; disabling the module never
      drops tenant data.
- [ ] Every items/files/functions query runs on the **project's own DB connection**;
      CI test proves tenant A token cannot read tenant B data on every endpoint.
- [ ] Permission compiler is the **only** path to content tables; raw `sql` module
      access to content stays admin/developer-gated and fully audited via `SqlAuditLog`.
- [ ] Row filters compiled with parameterized SQL only — fuzz test filter AST for
      injection (operators are an allow-list; field names validated against `_bf_fields`).
- [ ] Tokens stored hashed; shown once; expiry enforced; revocation immediate (no cache
      beyond 60 s); scoped to a role, never super-admin by default.
- [ ] Function isolates: memory/CPU/time caps; no ambient credentials; `bf.http` egress
      allow-list blocks RFC1918 + cloud metadata IPs; secrets injected per-project only.
- [ ] SQL functions run under derived Postgres roles with explicit GRANTs;
      `statement_timeout` and `idle_in_transaction_session_timeout` set.
- [ ] Webhook trigger paths use unguessable per-flow secrets; HMAC on outbound webhooks.
- [ ] File uploads: MIME sniffing (not extension), size limits per plan, image
      transforms only on stored files (no remote fetch), SVG sanitized or served with
      `Content-Disposition: attachment`.
- [ ] AI app-builder "apply" requires explicit review; generated permissions default
      deny; AI never receives another tenant's data in context.
- [ ] Rate limits per token and per role; execution-count and storage quotas wired to
      existing `UsageRecord`/billing.
- [ ] Audit: every meta change (collections, fields, roles, permissions, flows) writes
      `_bf_activity`; platform-level actions write existing `AuditLog`.
- [ ] If Couchbase adopted: scope-per-project, per-scope credentials, no shared bucket
      default collection, TLS-only, same CI cross-tenant test matrix.

---

## 11. Risks & Mitigations

1. **Permission bypass via legacy paths** (table-editor/sql-editor write directly to
   content tables). → Route their writes through the items service for `_bf_`-managed
   tables, or restrict them to developer+ role; CI cross-tenant/role matrix test.
2. **Schema-as-data drift** (someone alters a content table via raw SQL). → `bf
   introspect` reconciliation job diffs information_schema vs `_bf_fields`, surfaces
   drift in UI; sql module emits a warning when touching managed tables.
3. **Function runtime abuse** (cryptomining, SSRF, data exfiltration). → isolate caps,
   egress allow-list, per-plan execution quotas, anomaly alerts via observability module.
4. **Rename breakage** (env/CLI/issuer changes break existing customers). → Compat
   aliases through Sprint 6, dual-issuer JWT window, deprecation warnings with dates,
   migration doc; never rename Keycloak realms or MinIO buckets in place.
5. **Scope creep on the flows canvas / GraphQL.** → v1 flows are linear step lists;
   GraphQL behind a flag; node-canvas UI explicitly post-v1.
6. **AI app builder generating unsafe specs.** → spec is schema-validated, apply is
   transactional + reviewable, permissions default deny, generated code uses only the
   typed SDK (no raw SQL in templates).
7. **Solo-dev bus factor / agent drift.** → every sprint's section of this prompt is
   self-contained; graphify kept current; ADRs in `md/adr/` for each §2 decision.

---

## 12. First Implementation Tasks (start here, in order)

1. **Sprint 0, task 1:** Add `BASEFYIO_*` env support with `KOLAYBASE_*` fallback in
   platform-api config (`apps/platform-api/src/config`) and CLI; add the CI grep-gate
   for user-facing "Kolaybase".
2. Create `apps/platform-api/src/modules/collections` with: tenant migration runner for
   `_bf_` tables (001_bf_meta.sql above), `CollectionStore` interface,
   `RelationalStore.create/list` happy path, e2e test on a scratch project.
3. Implement collection-create → generated `CREATE TABLE` migration with field-type
   mapping (§3.2), preview endpoint returning the SQL before apply.
4. Build `/data-model` route in admin-ui: collection list + create dialog (extend
   `create-table-dialog.tsx` patterns), field builder for text/number/boolean/date/enum/
   json.
5. Items API `GET/POST /items/:collection` with filter AST compiler (start: `_eq _in
   _contains _and _or`), pagination, sort; wire `packages/sdk` `bf.items()` + tests.
6. Content list view `/content/[collection]` reusing table-editor primitives; then item
   editor with drafts.
7. Permission compiler skeleton: `(role, collection, action) → {where, fields}` applied
   inside `RelationalStore`; seed 4 system roles; cross-tenant CI test.
8. After each merged slice: `graphify update .`, changelog entry, demo note.

> When a sprint is done, return to this document, mark the sprint row, and proceed to
> the next section. Do not start Sprint N+1 with failing tests in Sprint N scope.
