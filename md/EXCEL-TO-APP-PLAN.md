# Basefyio + Nfyio: AI Application Architect — Implementation Plan

**Two products, one pipeline:**
- **Basefyio** — the data/app-intelligence factory: *turns Excel into an intelligent backend + app blueprint.*
- **Nfyio** — the builder/runtime factory: *turns the blueprint into real apps.*

*Upload your spreadsheet. Basefyio understands your business. Five minutes later Nfyio has built a working operating system for that business.*
Competitors do Excel → Database → CRUD; this does Excel → Business Understanding → Application Architecture → Running System.

**Pipeline:**

```
Excel Add-in
  ↓
BASEFYIO ───────────────────────────────────────────────
  Domain Intelligence      (AI output, user approves)
  Data Model               (database)
  Business Model           (digital twin: actors, objects, processes, metrics)
  Application Model        ← SOURCE OF TRUTH (product definition)
  schema · permissions · auth · APIs · sample data
  ↓
NFYIO BUILD PACKAGE        (the transfer artifact — see §4)
  ↓
NFYIO ──────────────────────────────────────────────────
  UI Model derivation + composition
  Web app · website · mobile · dashboards
  Hosted runtime + deployment
```

**The rule:** Basefyio does not finish the application UI. Basefyio produces the structured application blueprint; Nfyio consumes it and builds the final app experience.

The spreadsheet only contains data. The AI layer creates the application. Excel → Business Operating System, not Excel → Database.

**Decisions (locked):**
- **Hard product boundary.** Basefyio owns data, schema, metadata, auth, storage, and application intelligence. Nfyio owns final app generation, UI composition, frontend runtime, and deployment. Kolaybase/PostgreSQL implementation details never leak to Nfyio — it talks to Basefyio only through provider-neutral APIs and the Nfyio Build Package.
- **Application Model is the system of record.** Everything users edit — navigation, permissions, dashboards, reports, page visibility, entity names, business rules — lives here. It is what AI creates, what users edit, what versioning tracks. It lives on the Basefyio side.
- **Business Model sits above it** — the AI's understanding of the business itself (actors, processes, metrics). The Application Model is *generated from* the Business Model; future websites, workflows, agents, and reports are generated from it too.
- **Application Models are never overwritten.** Git-commit semantics via `ApplicationVersion`: every change is a new version with author, change summary, and `aiGenerated` flag. Rollback, diff, and "AI explain changes" become trivial.
- **UI Model is disposable — and now Nfyio's.** Never edited directly; Nfyio rebuilds it via `deriveUIModel(buildPackage)` on every package version. Basefyio ships definitions and design hints, not finished UI.
- **Metadata-driven runtime.** One hosted Nfyio runtime (`*.nfyio.app`) loads the build package + theme + permissions and renders. No per-project codegen, builds, repos, or deployments — the only path to 100,000 projects without operational collapse.
- **Excel add-in first** (Office.js taskpane). Web upload falls out free from the shared analyze endpoint.
- **Success metric:** spreadsheet → database + auth + API + working application + AI chat in **under 5 minutes**.

---

## 1. Gap analysis — what Kolaybase already has

| Pipeline step | Status | Where |
|---|---|---|
| Project provisioning (PG + Keycloak realm + MinIO) | ✅ Exists | `modules/projects/projects.service.ts` (`create()`, `provisionPostgres`) |
| File parsing (CSV/XLSX) + PG type inference | ✅ Exists | `modules/data-import/lib/file-parser.ts`, `lib/type-inferrer.ts` |
| Import pipeline (inspect → job → SSE progress → bad-rows CSV) | ✅ Exists | `modules/data-import/*` |
| Auto REST API (Supabase-style `rest/v1` pg-direct) | ✅ Exists | `modules/projects/project-data.{controller,service}.ts` |
| End-user auth for generated apps (signup/signin/magic-link/OTP) | ✅ Exists | `modules/projects/project-sdk-auth.*` |
| JS SDK | ✅ Exists | `packages/sdk` (`kolaybase-js`: auth, database, storage) |
| AI service (OpenAI + RAG) + embeddings | ✅ Exists | `modules/ai/*`, `modules/tenant-embedding/*` — makes "Ask your data" almost free |
| Realtime, billing, teams, email | ✅ Exists | respective modules |
| Excel add-in | ❌ Missing | — |
| AI understanding layer (domain intelligence, three models) | ❌ Missing | — |
| Semantic layer (`app_entities`) | ❌ Missing | — |
| App runtime (metadata-rendered app per project) | ❌ Missing | — |
| Wildcard subdomain hosting (`<slug>.nfyio.app`) | ❌ Missing | — |

---

## 2. The model stack

Stored in the platform Prisma DB, validated by zod schemas in a shared `packages/blueprint`. Ownership boundaries:

| Layer | Owns | Edited by | Versioned |
|---|---|---|---|
| Data Model | PG schema, indexes, constraints, imports — nothing UI | Schema migrations only | Yes |
| Business Model | Actors, objects, processes, metrics — the digital twin | AI (user-correctable at review) | Yes |
| Application Model | Entities, navigation, roles/permissions, features, business rules | **Users + AI** — system of record | **Yes — `ApplicationVersion`, git-commit semantics** |
| *— Nfyio Build Package — the boundary: everything above is Basefyio, below is Nfyio —* | | | |
| UI Model | Pages the Nfyio runtime renders | Nobody — Nfyio regenerates from each build package version | No (artifact) |

### 2a. Domain Intelligence — the magic moment

AI output shown to the user *before* anything is created:

```jsonc
{
  "domain": "crm",
  "confidence": 0.94,
  "businessExplanation": "This workbook appears to manage customer relationships, companies, contacts and sales activities.",
  "stats": { "customers": 3214, "companies": 412, "activities": 8921 },
  "recommendedRoles": ["Sales Rep", "Sales Manager"],
  "recommendedDashboards": ["Pipeline", "Activity", "Revenue"],
  "recommendedPages": ["Customers", "Companies", "Activities"],
  "recommendedAutomations": ["Follow-up Reminder", "Deal Stale Alert"]  // shown as "coming soon" in V1
}
```

Taskpane shows: *"We detected a CRM system. Customers: 3,214 · Companies: 412 · Activities: 8,921. Recommended app: customer management, company management, activity tracking, dashboard."* → **Generate App**. The user confirms the business understanding, not a table list.

### 2b. Data Model — pure database

```jsonc
{
  "tables": [
    { "name": "customers", "sourceSheet": "Sheet1",
      "columns": [{ "name": "email", "type": "text", "nullable": false, "unique": true }],
      "relations": [{ "column": "company_id", "references": "companies.id", "kind": "many-to-one" }] }
  ]
}
```

### 2c. Business Model — the digital twin

The AI's understanding of the business itself, not the app:

```jsonc
{
  "domain": "crm",
  "actors": ["Sales Rep", "Manager"],
  "objects": ["Customer", "Company", "Activity"],
  "processes": ["Lead Qualification", "Follow Up", "Customer Retention"],
  "metrics": ["Revenue", "Conversion Rate"]
}
```

The Application Model is generated from this. So are every future surface: marketing websites, workflow engines, agent definitions, analytics — one understanding, many outputs. **V1 consumers:** Application Model derivation and AI chat grounding only; workflows/agents/websites read it post-V1. In the generic-fallback path the Business Model is derived mechanically (objects = tables, no processes) so the pipeline never depends on AI succeeding.

### 2d. Application Model — the brain

```jsonc
{
  "applicationType": "crm",
  "entities": ["customers", "companies", "activities"],
  "navigation": ["dashboard", "customers", "companies", "activities"],
  "permissions": { "sales_rep": ["read:*", "write:activities"], "manager": ["*"] },
  "features": ["timeline", "dashboard"]
}
```

All editing happens here. Roles map to Keycloak realm roles; permissions compile to RLS policies. Versions are never overwritten — each edit appends an `ApplicationVersion` (git-commit semantics); rollback = re-derive UI Model from an older version, diff and "AI explain changes" read the version chain.

### 2e. UI Model — disposable generated artifact (Nfyio side)

`deriveUIModel(buildPackage)` — pure function in `packages/blueprint`, deterministic, unit-testable, executed by Nfyio. Rebuilt on every build package version; never hand-edited (a custom page designer is explicitly post-V1). Basefyio contributes form/view/dashboard *definitions* and design hints inside the package; Nfyio owns final page composition.

```jsonc
{ "pages": [
  { "type": "dashboard", "widgets": ["count:customers", "chart:revenue_by_month"] },
  { "type": "list", "table": "customers", "search": true },
  { "type": "detail", "table": "customers", "related": ["activities"] },
  { "type": "form", "table": "customers" },
  { "type": "kanban", "table": "deals", "groupBy": "stage" },
  { "type": "calendar", "table": "activities", "dateField": "due_at" },
  { "type": "chart", "table": "orders", "kind": "line", "x": "created_at", "y": "sum:total" }
] }
```

### 2f. Semantic layer — `app_entities`

Per-project metadata table created at generation time:

```jsonc
{ "table": "customers", "entity": "Customer", "description": "People who purchase products",
  "fields": { "ltv": "Lifetime value in USD" } }
```

AI features (chat, future agents) read this instead of raw table names. Cheap to build now, compounding value later.

---

## 3. Domain templates — first-class entities

No hardcoded CRM logic. Templates are DB rows (seeded, later editable/addable without deploys), each providing:

```ts
interface DomainTemplate {
  slug: string;                 // "crm"
  promptExamples: Json;         // few-shots for detectDomain() + model generation
  applicationDefaults: Json;    // navigation, roles, features for this domain
  uiOverrides: Json;            // e.g. CRM → timeline detail pages; Orders → kanban by status
  dashboardTemplates: Json;     // CRM: Sales Pipeline, Activity Timeline, Customer Health
  chartTemplates: Json;         // Inventory: Stock Levels trend, top movers
  kpiTemplates: Json;           // CRM: Revenue, Conversion Rate; Inventory: Reorder Alerts
  workflowTemplates: Json;      // populated post-V1, schema reserved now
  agentTemplates: Json;         // populated post-V1, schema reserved now
}
```

`detectDomain()` returns a slug; the template drives AI prompting, UI derivation, and dashboard/KPI generation. Templates encode domain knowledge so the AI doesn't reinvent it per upload — CRM automatically knows Sales Pipeline / Activity Timeline / Customer Health; Inventory knows Stock Levels / Reorder Alerts / Warehouse Dashboard. (Workflow/agent template fields ship empty in V1 — reserving the schema costs nothing, retrofitting it later costs a migration.)

| Template | Priority |
|---|---|
| CRM | P0 |
| Inventory | P0 |
| Orders | P0 |
| Projects | P1 |
| HR | P1 |
| Help Desk | P1 |
| Asset Management | P1 |
| Generic (fallback: 1 table/sheet, list+form+detail) | P0 — always works |

---

## 4. Basefyio → Nfyio handoff

Basefyio turns Excel/business data into a structured backend and application blueprint. It does not fully finish or own the generated app UI/runtime. At generation time it exports a complete **Nfyio Build Package**:

```jsonc
{
  "projectId": "...", "tenantId": "...",
  "dataModel": {},            // entity schemas + relationships (provider-neutral, no PG internals)
  "permissionsModel": {},     // roles + access rules (not RLS SQL — that's Basefyio-internal)
  "applicationModel": {},     // + version ref
  "navigationModel": {},
  "formDefinitions": {},
  "tableListViews": {},
  "dashboardReportDefinitions": {},
  "apiDefinitions": {},       // provider-neutral endpoint catalog (rest/v1 surface, described abstractly)
  "authRequirements": {},     // modes, roles — not Keycloak realm internals
  "sampleRecords": {},
  "aiProvenance": {},         // domain intelligence, business model, reasoning, confidence
  "designHints": {},          // theme, density, domain idioms (e.g. "CRM → timeline on detail")
  "generatedAppIntent": ""    // what the app is for, in prose — grounds Nfyio's AI chat + composition
}
```

Nfyio consumes the package and builds: web apps, websites, mobile apps, dashboards, generated UI, and the hosted runtime/deployment experience.

**Hard boundary:**

| Basefyio owns | Nfyio owns |
|---|---|
| Data, schema, metadata, auth, storage | Final app generation, UI composition |
| Application intelligence (AI understanding, models, versions) | Frontend runtime, theming, deployment |
| Provider internals: PostgreSQL, Keycloak, MinIO, RLS | Talks only provider-neutral APIs + Build Package |

Packages are versioned 1:1 with `ApplicationVersion` — every Application Model change emits a new package; Nfyio re-derives and re-renders. The package is also the natural seam for a future third-party builder ecosystem (anything that can consume a Build Package can build on Basefyio).

---

## 5. Phases

### Phase 0 — Foundations (≈1–1.5 weeks)
Four Prisma models (the foundation every future source — CSV, Google Sheets, Airtable, Notion, SQL, APIs, documents, email — plugs into):

```prisma
model Blueprint {
  id                 String  @id
  projectId          String?
  teamId             String
  domainIntelligence Json
  dataModel          Json
  businessModel      Json    // digital twin
  currentVersionId   String  // → ApplicationVersion (source of truth lives there)
  uiModel            Json    // derived artifact, regenerated per version
  status             String  // draft | approved | generated
}

model ApplicationVersion {
  id               String   @id
  blueprintId      String
  version          Int
  applicationModel Json
  createdAt        DateTime
  createdBy        String
  changeSummary    String
  aiGenerated      Boolean
}

model AppEntity {
  projectId   String
  entityName  String
  tableName   String
  description String
  metadata    Json    // field-level descriptions
}

model DomainTemplate {
  slug                String @id
  promptExamples      Json
  applicationDefaults Json
  uiOverrides         Json
  dashboardTemplates  Json
  chartTemplates      Json
  kpiTemplates        Json
  workflowTemplates   Json   // empty in V1
  agentTemplates      Json   // empty in V1
}
```

Application Models are append-only: edits create a new `ApplicationVersion`, `currentVersionId` moves, nothing is destroyed. Each version emits a corresponding Nfyio Build Package.

- `packages/blueprint`: zod schemas for all layers **including the Nfyio Build Package contract**, + `deriveApplicationModel(businessModel, template)` (Basefyio) + `buildPackage(blueprint, version)` (Basefyio) + `deriveUIModel(buildPackage)` (Nfyio). All pure, unit-testable. The package schema is the inter-product API — design it first.
- Wildcard DNS + reverse proxy for `*.nfyio.app` → Nfyio runtime.

### Phase 1 — Excel add-in skeleton (≈2 weeks)
New `apps/excel-addin` (Office.js + React taskpane, Vite).
- Auth via browser handoff (reuse `admin-ui/app/cli-authorize` pattern).
- Read sheet names, headers, ~100 sample rows; let user exclude junk sheets.
- Upload to `POST /blueprints/analyze`; render the Domain Intelligence approval screen.
- Sideloading docs now; AppSource submission at end of V1.

### Phase 2 — AI understanding layer (≈2–3 weeks) — *the product lives here*
New `modules/blueprint` in platform-api. `analyze()` runs:
1. Existing `type-inferrer` per sheet (deterministic, free) → Data Model draft; FK inference (`*_id` matching, repeated-value columns → lookup tables).
2. Structured-output OpenAI call (reuse AiService client) → Domain Intelligence + **Business Model** (actors, objects, processes, metrics) + entity naming/normalization.
3. `deriveApplicationModel(businessModel, template)` — template defaults + AI recommendations → Application Model v1 (`aiGenerated: true`).
4. Validate every layer against `packages/blueprint`; **deterministic generic-template fallback if validation fails** — analyze never errors out (fallback Business Model: objects = tables, no processes).
5. `deriveUIModel(applicationModel, template)`.
- `POST /blueprints/:id/approve` accepts Application Model edits; UI Model regenerates.
- P0 templates: CRM, Inventory, Orders, Generic.

### Phase 3 — Generation pipeline (≈1–2 weeks, mostly glue)
`POST /blueprints/:id/generate` as a BullMQ job (reuse `queue`):
1. `ProjectsService.create()` — DB, realm, storage. (reuse)
2. DDL from Data Model (reuse `quoteIdent`/DDL helpers); create `app_entities` and seed from AI output.
3. Realm roles from Application Model permissions; compile permissions → RLS policies (patterns from `md/RLS.md`).
4. Row import via existing `DataImportProcessor`.
5. **Emit the Nfyio Build Package** (`buildPackage(blueprint, version)`) and hand off to Nfyio.
6. SSE progress to the taskpane (same mechanism as data-import jobs); return the Nfyio app URL.

### Phase 4 — Nfyio runtime (≈3–5 weeks, biggest new piece)
New `apps/nfyio-runtime` (Next.js): hostname → tenant → loads Build Package → derives UI Model → renders.
- **V1 renderers:** list, form, detail, dashboard, chart. (Kanban/calendar moved post-V1 to protect the 5-minute promise; dnd-kit groundwork already exists in admin-ui when they land.)
- Data via `kolaybase-js` against the provider-neutral `apiDefinitions` surface with project anon key; end-user login per `authRequirements` (backed by `project-sdk-auth`, but Nfyio never sees Keycloak internals); navigation + role-gated pages from the package.
- Packages fetched at request time (cached, invalidated on package version bump) — edits are live instantly: no build queue, no deploy pipeline.

### Phase 5 — "Ask your data" AI chat (≈1–2 weeks)
Chat panel rendered by Nfyio, answered by Basefyio (chat is application intelligence — Basefyio's side of the boundary, exposed as a provider-neutral `/intelligence/ask` API): *"Show me customers that haven't ordered in 90 days." "Which products generate most revenue?" "Create a dashboard for monthly sales."*
- Reuse `AiService`/`RagService` + tenant embeddings; ground prompts in `app_entities`, the Business Model, and `generatedAppIntent`.
- NL → safe parameterized SQL (read-only role, Basefyio-internal) → table/chart answer; "save as dashboard widget" appends a dashboard definition to the Application Model → new version → new package → Nfyio re-renders.
- This is the differentiator vs. APEX/Power Apps — ship it inside V1, not after.

### Phase 6 — Review loop & launch (≈2 weeks)
- Application Model editor in admin-ui (rename entities, toggle features, edit roles); read-only review in taskpane.
- Excel re-sync (append/upsert into existing tables — data-import supports this).
- Invite users flow, billing hook (reuse billing module), AppSource submission.

**Total V1: ~11–14 weeks single-track; ~8–9 weeks with two people (add-in + understanding layer in parallel with runtime).**

### V1 scope summary

| Ship | Delay |
|---|---|
| Excel add-in | Workflow builder |
| Domain Intelligence (AI review before generation) | Mobile app |
| Data Model + Application Model + derived UI Model | Public websites/portal |
| Metadata runtime: CRUD pages, dashboards, charts | Marketplace |
| Roles & permissions (→ Keycloak + RLS) | Code export / eject |
| AI chat ("Ask your data") | Custom page designer, kanban/calendar |

The bar: spreadsheet in → database + auth + API + CRM/Inventory/Orders app + AI chat out, reliably, in under 5 minutes. That alone is a compelling alternative to APEX, Power Apps, and Retool, with Excel as the entry point.

---

## 6. Post-V1 roadmap (ordered)

1. More sources: CSV (already supported), Google Sheets, Airtable, Notion, existing SQL DBs, APIs — all feed the same understanding engine via the Phase 0 models.
2. Kanban + calendar renderers; custom page designer (first UI Model hand-edits, carefully — they break disposability).
3. Public website/portal pages (read-only UI Model pages, SEO).
4. Workflows (status transitions, email on insert — reuse email + realtime modules).
5. AI agents inside generated apps (semantic layer + rag already in place).
6. Mobile: PWA first (runtime is responsive), native wrapper later.
7. P1 domain templates: Projects, HR, Help Desk, Asset Management — DB rows, no deploy needed.
8. Eject-to-code: serialize models → Next.js scaffold + kolaybase-js, deploy via existing Vercel/GitHub integrations.

```
Excel · CSV · Google Sheets · Airtable · Notion · SQL · API · Documents · Email
                              ↓
                  Basefyio Intelligence Layer
                              ↓
              Business Model → Application Model
                              ↓
                      Nfyio Build Package
                              ↓
                Nfyio Builder + Hosted Runtime
                              ↓
Web App · Customer Portal · Website · Mobile · API · Reports · Workflows · AI Agents
```

At that point Basefyio is not competing with spreadsheet importers — it competes with APEX, Power Apps, Retool, and AppSheet, with a radically simpler entry point.

---

## 7. Risks & open questions

- **AI understanding quality is the product.** Mitigation: deterministic generic fallback always works; P0 domain templates as few-shots; user confirms the business explanation before anything is provisioned; confidence < threshold → present generic with suggestions instead of a wrong guess.
- **The Business Model layer adds an inference hop.** A wrong Business Model now cascades into a wrong Application Model. Mitigation: templates anchor the derivation (AI fills in a known shape rather than inventing one); user corrects the Business Model at the review step; generic fallback derives it mechanically. Do not let V1 features other than chat grounding and derivation depend on it.
- **Scope creep in Phase 4.** Five page types + permissions + theming is still the long pole. Renderers share one data-grid core; anything beyond the five waits for post-V1.
- **UI Model disposability discipline.** The moment someone hand-patches a UI Model, regeneration breaks. Enforce in code: runtime and API only ever read UI Models written by `deriveUIModel()`; no write endpoint for it.
- **Office.js auth UX** (dialog API, popup blockers). Mitigation: device-code fallback; web upload path exists regardless.
- **Messy workbooks** (pivot tables, merged cells, summary rows). Mitigation: header-detection heuristics, sheet exclusion in taskpane, type-inferrer widens to `text` when unsure.
- **NL→SQL safety** in chat: read-only DB role, statement allowlist, row limits, never service-role.
- **Two-product split is a logical boundary, not V1 infrastructure.** In V1 both sides live in this monorepo and one deployment; the boundary is enforced by the Build Package contract and provider-neutral APIs (lint rule: `nfyio-runtime` may import only `packages/blueprint` + `packages/sdk`, never platform-api internals). Splitting into separate services/teams/billing is a later decision the contract keeps cheap. Don't pay the distributed-systems tax before there are users.
- **Boundary leak pressure.** The first time Nfyio needs something not in the package (a count, a permission nuance), the temptation is a direct DB peek. Every such need must become a package field or a neutral API — treat leaks as P0 bugs.
- **Brand:** Basefyio (intelligence) / Nfyio (apps) on top of Kolaybase infrastructure — naming settled; decide only how visible Kolaybase remains in marketing.
- **Per-project anon key + RLS correctness:** permissions now compile from the Application Model, so RLS generation needs tests against the `md/RLS.md` probes — this is the highest-severity correctness risk.
