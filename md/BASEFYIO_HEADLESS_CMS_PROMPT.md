# Basefyio Headless CMS Prompt — Directus Feature Parity Layer

**Revision v3** (2026-06-06) — **this layer now belongs to Sharefyio, an independent
product** (see `md/SHAREFYIO_PRODUCT_PROMPT.md`). Do NOT implement anything from this
document in the Basefyio/kolaybase-new codebase. It remains the detailed engineering
spec (field system, versioning, translations, layouts, flow operations, realtime,
insights, MCP) to be copied into the `sharefyio` repo with the rename mapping
(`_bf_`→`_sf_`, `Project.modules.cms` gating removed — CMS IS the product there).

**Revision v2** (superseded) — entire layer scoped inside the optional per-project
CMS module (`Project.modules.cms`); positioning guard added.

> Companion to `md/BASEFYIO_IMPLEMENTATION_PROMPT.md` (the master prompt). That document
> defines the foundation (collections, items, RBAC, files, flows, APIs, AI builder).
> THIS document adds the full **headless CMS** feature set distilled from
> https://directus.com/docs (Directus 11 docs, read 2026-06-06) — versioning,
> translations, live preview, layouts, field interfaces, the flow-operation catalog,
> realtime, insights, and an MCP server — all as Basefyio-native modules.
>
> The ⛔ Critical Execution Guard in the master prompt applies verbatim here:
> verify paths, graphify before search, vertical slices, no "Kolaybase" anywhere
> user-facing.
>
> **⚠ Positioning guard: Basefyio is NOT becoming Directus.** Everything in this
> document lives inside the **optional per-project Headless CMS module**
> (`Project.modules.cms`, defined in master §0). Every endpoint here sits behind
> `ModuleEnabledGuard('cms')`; every UI screen renders only when the module is enabled.
> Projects that don't enable the module are completely unaffected — core Basefyio
> (Postgres, auth, storage, SQL editor, existing APIs) must never depend on anything
> defined below. Marketing language: "Basefyio backend platform, with an optional
> headless CMS module" — never "Basefyio CMS".

---

## 1. Field System Upgrade (extends master §3.1 `_bf_fields`)

Directus separates **type** (storage) from **interface** (input widget), **display**
(render), **validation**, and **conditions**. Upgrade `_bf_fields.options` into explicit
columns/keys:

```sql
ALTER TABLE _bf_fields
  ADD COLUMN IF NOT EXISTS interface text,          -- input widget id
  ADD COLUMN IF NOT EXISTS interface_options jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS display text,            -- list/render formatter id
  ADD COLUMN IF NOT EXISTS display_options jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS validation jsonb,        -- filter-AST rule + custom message
  ADD COLUMN IF NOT EXISTS conditions jsonb,        -- [{rule, hidden?, readonly?, required?, options?}]
  ADD COLUMN IF NOT EXISTS width text NOT NULL DEFAULT 'full',  -- half|full|fill
  ADD COLUMN IF NOT EXISTS note text,               -- helper text in editor
  ADD COLUMN IF NOT EXISTS readonly boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS searchable boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS translations jsonb;      -- {lang: label} for field labels
```

**Type set (map to Postgres):** String, Text, UUID, Hash, Alias (no column —
presentational/relational), Integer, BigInteger, Float, Decimal, Boolean, Timestamp,
DateTime, Date, Time, Binary, JSON, CSV (text[]), and **Geospatial** (Point, LineString,
Polygon, Multi*) via PostGIS — wire to the existing `packages/geo`.

**Built-in interfaces (v1 set):** input, textarea, WYSIWYG (rich text), markdown, code
(Monaco), select-dropdown, select-radio, checkboxes, tags, datetime, color, slider,
toggle, file, image, files (o2m), m2o-dropdown, o2m-list, m2m-list, map (geo),
slug (auto from another field), hash. Each interface declares which types it supports.

**Displays:** raw, formatted-value (prefix/suffix/format), datetime-relative ("3h ago"),
labels (colored badge per enum value), user (avatar+name), file (thumbnail), boolean-icon,
color-swatch, rating. **Conditional styles**: color/icon/text overrides when value
matches a filter rule.

**Validation runs twice** (Studio client-side preview + server authoritative) and uses
the same filter AST as permissions. Custom failure message per rule. DB-level constraints
stay what the schema generator created — these are app-level validations.

**Conditions:** rules over sibling field values toggling hidden/readonly/required or
patching interface options. Evaluate client-side in the editor; re-validate server-side
on write (a hidden-by-condition required field is not required).

---

## 2. Content Versioning (Directus model, replaces simple draft/published of master §3.2)

Keep `status` for simple collections; add **opt-in versioning** per collection
(`_bf_collections.versioning boolean DEFAULT false`). When enabled, the workflow is
**draft-first**: the published item is read-only in the editor; edits happen in a
version.

```sql
CREATE TABLE IF NOT EXISTS _bf_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection text NOT NULL,
  item_id text,                         -- NULL = item-less draft (not yet published)
  key text NOT NULL,                    -- 'draft' reserved; 'published'/'main' forbidden
  name text NOT NULL,
  delta jsonb NOT NULL DEFAULT '{}',    -- only changed fields vs published
  hash text NOT NULL,                   -- published-item hash at branch time (conflict detect)
  date_created timestamptz NOT NULL DEFAULT now(),
  date_updated timestamptz,
  user_created text, user_updated text,
  UNIQUE (collection, item_id, key)
);

CREATE TABLE IF NOT EXISTS _bf_revisions (   -- fine-grained change history
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection text NOT NULL, item_id text,
  version_id uuid REFERENCES _bf_versions(id) ON DELETE SET NULL, -- null = on published
  activity_id bigint,                   -- link to _bf_activity row
  delta jsonb NOT NULL,                 -- fields changed in THIS save
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Rules (match Directus exactly):
- A **global "draft" version** is implicitly available for every item of a versioned
  collection; it materializes as a row on first save. Keys `published|main|draft` are
  reserved for custom versions → 400.
- `+ Create Item` on a versioned collection opens straight into an **item-less draft**
  (`item_id NULL`). Publishing it creates the item (requires *create* permission) and
  skips the comparison modal.
- Versions save with **required-field validation deferred to publish time**.
- **Publish** = comparison modal (field-level diff, accept/reject per field) → merged
  into the live row → previous state preserved in revisions → then "Keep/Discard
  version" (draft: "Keep/Discard Edits").
- API: `GET /items/:c/:id?version=draft` returns published+delta merged.
  `GET/POST/PATCH/DELETE /versions[...]`, `POST /versions/:id/publish`,
  `POST /versions/:id/compare`. Version response carries `{key, name, delta, hash, ...}`.
- Collection list header gets a **Published/Draft selector**; draft mode lists items
  with pending drafts incl. item-less ones; batch-delete in draft mode deletes **only
  the draft versions**; batch edit/archive/export/sort disabled in draft mode.
- Revisions UI in the item right rail ("Updated 2 Fields"), comparison modal with
  previous-vs-latest toggle and **Apply** to restore.
- Retention: per-plan cap + scheduled cleanup job for `_bf_revisions` (it grows fast).

---

## 3. Translations (content i18n)

Directus pattern: a special **translations relation**. For collection `articles`, the
field builder's "Translations" interface generates:

```sql
CREATE TABLE IF NOT EXISTS languages (
  code text PRIMARY KEY,                -- 'en-US', 'tr-TR'
  name text NOT NULL, direction text NOT NULL DEFAULT 'ltr'
);
CREATE TABLE IF NOT EXISTS articles_translations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  articles_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  languages_code text NOT NULL REFERENCES languages(code),
  -- + one column per translated field (title, body, ...)
  UNIQUE (articles_id, languages_code)
);
```

- Non-translated fields stay on the parent; translated fields move to the
  `_translations` table. Editor shows a language switcher inside the item page with
  per-language completion indicators.
- API: `?fields=*,translations.*` plus a deep filter
  `?deep[translations][_filter][languages_code][_eq]=tr-TR`; SDK helper
  `bf.items('articles').list({ lang: 'tr-TR' })` flattens the active language.
- **Studio i18n** is separate: admin-ui strings via next-intl (en + tr to start);
  field labels translatable via `_bf_fields.translations`.

---

## 4. Layouts, Saved Views, Dynamic Filter Variables (extends master §5.2)

- **Layouts** per collection page: `tabular` (default), `cards` (image/title/subtitle
  mapping), `calendar` (start/end date field mapping), `kanban` (group-by enum/status
  field, drag between columns = PATCH), `map` (geo field, PostGIS + packages/geo).
  Layout choice + its options persist in `_bf_presets.layout`.
- **Bookmarks** (named presets) shown under the collection in the nav; a nameless
  preset is the user's default view (already specced in master — keep).
- **Dynamic filter variables** resolved server-side by the permission/filter compiler:
  `$CURRENT_USER`, `$CURRENT_ROLE`, `$CURRENT_ROLES`, `$CURRENT_POLICIES`,
  `$NOW`, `$NOW(<adjustment>)` e.g. `$NOW(-1 year)`. Usable in permissions row_filter,
  list filters, validations, and flow conditions.
- Filter UI supports nested **AND/OR groups** (indentation = grouping), mapping 1:1 to
  the `_and`/`_or` AST.

---

## 5. Live Preview & Visual Editor

- **Live Preview** (per collection setting): `preview_url` template with `{{field}}` and
  `{{$version}}` variables, e.g. `https://site.com/{{slug}}?preview=true&version={{$version}}`.
  Item editor gains a split-pane preview (mobile/desktop width toggle). The frontend
  reads `?version=` and fetches `/items/posts/42?version=draft` with a preview token
  (scoped, read-only, expiring `_bf_tokens` row).
- **Visual Editor** (project-level URL setting, post-v1 stub acceptable): injects a
  small JS module into the customer site that maps `data-collection/data-field/
  data-primary-key` attributes to inline edit popovers; version dropdown
  (Published/Draft) in its header. Generated apps from the App Builder emit these data
  attributes by default so Visual Editor works out of the box.
- **Collaborative editing** (post-v1): presence + field-level locks over the existing
  realtime module.

---

## 6. Flows: Operation Catalog (extends master §6 — steps become typed operations)

Master prompt's `_bf_flows.steps` entries get `type` + success/failure routing:
`steps: [{key, type, options, resolve: nextKey, reject: nextKey}]` — a **data chain**
where each operation appends its output under its `key` (`$trigger`, `$last`,
`{{ key.field }}` templating).

Operation types (Directus parity, map to Basefyio modules):

| Type | Behavior |
|---|---|
| `condition` | filter-AST rule over the data chain → resolve/reject path; missing field ⇒ reject |
| `run_script` | sandboxed JS/TS (isolated-vm, no modules/fs/net) `module.exports = (data) => ({...})`; thrown error breaks the chain |
| `create_data` / `read_data` / `update_data` / `delete_data` | items ops with **Permissions scope** (run as role), IDs or query, Emit Events toggle (loop guard) |
| `request_url` | HTTP request (method/url/headers/body), response → chain; egress allow-list |
| `send_email` | existing email module; WYSIWYG/Markdown/Template body, batch via array of recipients |
| `send_notification` | in-app notification to project users (see §8) |
| `transform_payload` | literal JSON with template interpolation → chain |
| `jwt` | sign/verify/decode (jsonwebtoken semantics) |
| `log` | message to execution log; null on chain |
| `sleep` | delay ms |
| `throw_error` | custom code + HTTP status + message; halts flow |
| `trigger_flow` | invoke another flow; iteration modes **Serial / Batch(size) / Parallel** when payload is an array |
| `ai` | Basefyio extra: existing ai module, prompt template + JSON-schema output |

Trigger upgrade (master §6): event hooks get two modes — **Action (non-blocking,
after commit)** and **Filter (blocking, before commit)**: a blocking flow ending in
reject/throw **cancels the transaction**; its returned payload can mutate the write.
Plus schedule (cron), webhook (GET/POST, optional sync response body), manual (button
on collection page, with confirmation dialog option), and `another_flow`.

UI: upgrade the vertical step list to a **node canvas** (React Flow) — each operation a
card with resolve (success) / reject (failure) edges; side panel shows the live data
chain of the selected execution.

---

## 7. Realtime (Directus Realtime parity over existing `realtime` module)

- WebSocket endpoint per project: `wss://api.basefyio.com/v1/projects/:id/ws`.
- Auth handshake (token in first message), then `{type:'subscribe', collection, query:{fields,filter}}`.
- Server pushes `init` + `create/update/delete` events **filtered through the same
  permission compiler** as REST (no permission bypass over WS).
- CRUD over WS optional (post-v1); subscriptions + auth refresh (`ping/pong`,
  token refresh message) in v1.
- SDK: `bf.realtime.subscribe('articles', {filter}).on('update', cb)`.
- Internal events (item changes) already flow through the store layer hooks (master §6)
  — fan out to both flows and WS subscribers from the same emission point.

---

## 8. Notifications & User Directory

```sql
CREATE TABLE IF NOT EXISTS _bf_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient text NOT NULL,              -- Keycloak sub
  sender text, subject text NOT NULL, message text,
  collection text, item_id text,        -- deep link
  status text NOT NULL DEFAULT 'inbox', -- inbox|archived
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- Bell icon in project header (reuse `notifications-bell.tsx` patterns); inbox/archive;
  emitted by flows (`send_notification`) and by comment @mentions.
- **User Directory** (`/users` in project scope, screenshot 9): lists the project's
  Keycloak realm users with role, status, last access; invite user (email via existing
  email module → Keycloak invite); per-user policy attachments (master §3 RBAC); user
  detail drawer matches the item editor pattern.

---

## 9. Insights (dashboards, screenshot 11)

```sql
CREATE TABLE IF NOT EXISTS _bf_dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, icon text, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS _bf_panels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES _bf_dashboards(id) ON DELETE CASCADE,
  type text NOT NULL,        -- metric|time_series|bar|pie|list|label
  name text, icon text, color text,
  position jsonb NOT NULL,   -- {x,y,w,h} grid units
  options jsonb NOT NULL     -- {collection, aggregate: count|sum|avg|min|max,
);                           --  field?, group_by?, date_field?, range?, filter?}
```

- Aggregates compile to SQL through the **same permission compiler** (a viewer sees
  only rows their role allows). API: `GET /items/:c/aggregate?aggregate[count]=*&groupBy=status`.
- Dashboard grid with drag/resize (grid units), panel editor drawer, dashboard
  import/export as JSON (screenshot 11 shows Import side panel).
- v1 panel set: metric, time series, bar, pie, list, label. Recharts in admin-ui.

---

## 10. Project Settings & Appearance (screenshots 7–8)

Per-project settings stored in tenant DB `_bf_settings` (single row, jsonb):
project name, description, logo (file id), favicon, public note, default language,
**theming** (light/dark palettes, accent color → CSS vars in admin-ui project scope),
custom CSS (admin-scoped, sanitized), default appearance per user override,
preview/visual-editor URLs, allowed transform presets for `/assets`.

---

## 11. MCP Server (Directus "AI" parity — strong Basefyio differentiator)

Expose each project as an **MCP server**: `https://api.basefyio.com/v1/projects/:id/mcp`
(streamable HTTP). Tools, all routed through the permission compiler with the
caller's token:

- `read_collections` / `read_fields` — schema introspection
- `query_items` (collection, filter AST, fields, sort, limit), `create_item`,
  `update_item`, `delete_item`
- `read_files` / `upload_file_from_url`
- `invoke_function` (respecting input_schema)
- `read_insights` (run a panel's aggregate)

This lets Claude/any MCP client operate on a customer project safely — and the Excel
add-in + AI App Builder (master §7) consume the same tool surface. Auth: static token
(role-scoped) or OAuth via Keycloak. Rate-limited per token.

---

## 12. Sprint Plan Extension (continues master §9; same solo-dev + agents, 2-week cadence)

| Sprint | Theme | Done means |
|---|---|---|
| **8** | Field system + layouts | Interfaces/displays/validation/conditions/width on `_bf_fields`; editor renders all v1 interfaces; cards/kanban/calendar layouts; dynamic filter variables in compiler; AND/OR filter groups UI |
| **9** | Versioning + revisions | §2 complete: draft-first read-only published view, item-less drafts, comparison-modal publish, revisions rail + restore, Published/Draft list selector, retention job |
| **10** | Translations + live preview | Translations relation generator + language switcher in editor; deep filter + SDK lang helper; studio i18n (en/tr); per-collection preview URL + split-pane preview with version variable; preview tokens |
| **11** | Flow operations + realtime | §6 operation catalog on node canvas (React Flow); blocking filter hooks; trigger_flow iteration modes; WS subscriptions with permission filtering; SDK realtime |
| **12** | Insights + notifications + users + settings | Dashboards/panels CRUD + grid UI; aggregate API; notifications inbox; user directory + invites; project settings/appearance |
| **13** | MCP server + polish | §11 MCP tools live + docs; map layout (PostGIS); visual-editor stub; collaborative-editing spike report; security pass: re-run master §10 checklist over ALL new endpoints (versions, WS, aggregates, MCP) |

Risks to watch (adds to master §11): revisions table growth (retention job is not
optional — ship it with §2, not after); WS permission filtering must reuse the compiler,
never re-implement; blocking filter hooks can deadlock writes — enforce timeout +
circuit breaker; MCP write tools default to dry-run unless token role has explicit
write permission.

---

## 13. First Tasks for THIS layer (after master Sprint 7 ships)

1. Migration `00X_bf_field_system.sql` (§1 ALTERs) + interface/display registries in
   `apps/platform-api/src/modules/collections`; editor widget registry in admin-ui.
2. Filter-compiler support for `$CURRENT_USER/$CURRENT_ROLE/$NOW(...)` + unit fuzz tests.
3. `_bf_versions`/`_bf_revisions` migration + `?version=` merge logic in both stores;
   then the editor version dropdown.
4. Kanban + cards layouts (highest user-visible value after tabular).
5. WS subscribe path through permission compiler (read-only) + SDK helper.
6. After each slice: `graphify update .`, changelog, demo note (per the ⛔ guard).
