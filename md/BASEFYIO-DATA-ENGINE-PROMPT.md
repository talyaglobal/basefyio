# Prompt: Add NoSQL Document Data Plane to Basefyio

> Copy everything below this line into your AI coding agent (Claude Code, etc.).

---

## Role

You are a senior platform engineer working on **Basefyio** (codebase: `kolaybase-new`), a self-hosted, multi-tenant backend platform. Your task is to introduce a **NoSQL document data plane** alongside the existing **PostgreSQL control plane**, behind a storage abstraction called the **Basefyio Data Engine**.

**Vendor neutrality rule:** the concrete NoSQL document store is an implementation detail confined to one provider directory. Its vendor name must never appear outside `packages/data-engine/providers/nosql/` — not in interfaces, module names, env var names, API routes, UI strings, docs headings, error messages, or commit-facing identifiers. Everywhere else, say "NoSQL store" or "Data Engine". The store is selected as a Phase 0 infrastructure decision (requirements below: document collections, server-side parameterized queries, secondary indexes, CAS/optimistic concurrency, scope-or-equivalent namespacing).

## Current State (ground truth — verify before changing anything)

- Monorepo: `apps/platform-api` (NestJS + Prisma + TypeScript), `apps/admin-ui` (Next.js 14, Tailwind, shadcn/ui), `apps/website`, `packages/cli` (`kb` CLI), `packages/sdk`.
- PostgreSQL 16 is the only database. Each project/tenant gets its own PostgreSQL database. Prisma manages the platform schema.
- Auth: Keycloak 24 (realm per project). Object storage: MinIO. Orchestration: Docker Compose (`docker-compose.yml`, `docker-compose.prod.yml`, `docker/`).
- `platform-api/src/modules` already contains: `ai`, `auth`, `billing`, `projects`, `sql`, `storage`, `realtime`, `queue`, `redis`, `search`, `data-import`, and others. Study `projects` and `sql` modules first — they define the per-tenant provisioning and data-access patterns you must follow.
- A knowledge graph exists at `graphify-out/`. If the `graphify` CLI is available, run `graphify query "<question>"` before grepping; run `graphify update .` after changes.

## Target Architecture

```
Excel Add-in / Admin UI / SDK / Generated Apps
                    |
              Platform API (NestJS)
                    |
            Basefyio Data Engine
            (storage abstraction)
              /            \
   PostgreSQL (control)   NoSQL store (data)
```

**PostgreSQL remains the system of record** for: users, tenants/projects, billing, permissions, audit logs, workflows, system config, and **all generated-app metadata** (app definitions, entity schemas, form definitions, API definitions).

**The NoSQL store becomes the application data plane** for: generated application records, dynamic form submissions, AI-generated schema instances, and user content.

**Hard rule:** no module outside the Data Engine may import the NoSQL store's SDK directly. All document access goes through the abstraction, and **generated applications never know which provider is underneath**. The provider tree is: NoSQL and Postgres now; additional document/KV stores (e.g. MongoDB, DynamoDB, FoundationDB) as possible future providers — design the interface so these are plausible. Public naming is "Basefyio Data Engine" — no vendor name may appear in any user-facing API path, error message, UI string, or SDK method name.

## Deliverables

### 1. `@basefyio/data-engine` package (`packages/data-engine`)

Package layout:

```
src/
 ├── interfaces/        data-engine.ts, query.ts, types.ts
 ├── providers/         nosql/, postgres/
 ├── tenancy/           names.ts (sanitization), provisioning.ts
 ├── validation/        schema.ts (ajv wrapper)
 └── index.ts           provider factory: DATA_ENGINE_PROVIDER → engine
```

- Define a provider-agnostic interface, roughly:

```ts
interface DataEngine {
  provisionTenant(projectId: string, tier?: IsolationTier): Promise<TenantDataPlane>;
  deprovisionTenant(projectId: string): Promise<void>;
  collection(projectId: string, entity: string): EntityCollection;
  capabilities(): ProviderCapabilities;
}

interface ProviderCapabilities {
  transactions: boolean;
  fullTextSearch: boolean;
  vectorSearch: boolean;
  ttl: boolean;
  vector?: VectorCapabilities;   // interface only — no implementation now
}

interface VectorCapabilities {
  embeddings: boolean;
  hybridSearch: boolean;
}
// NoSQL provider: capabilities reflect the chosen store. Postgres provider: transactions only.
// Callers must branch on capabilities(), never on provider name:
// `if (provider === "nosql")` (or any vendor check) outside
// packages/data-engine/providers is a CI failure (add a lint/architecture test).
// Do NOT implement vector/embedding features — the AI builder will need
// semantic search / RAG later; reserving the types now avoids a redesign.

interface EntityCollection {
  insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult>;
  get(id: string): Promise<DocResult | null>;
  update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult>;
  replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult>;
  delete(id: string): Promise<void>;
  query(q: EntityQuery): Promise<Page<DocResult>>;   // filter, sort, paginate, project
  count(filter?: Filter): Promise<number>;
  ensureIndexes(defs: IndexDef[]): Promise<void>;
}
```

- Implement `NoSqlDataEngine` using the chosen store's official Node SDK (SDK import allowed only inside `providers/nosql/`).
- **Tenancy mapping — shared-by-default, isolated-by-tier.** Do NOT provision a namespace (scope) per project; at 10k projects × 50–200 AI-generated entities that yields hundreds of thousands to millions of namespaces/collections, which no cluster wants. Default model:
  - One top-level container `basefyio-apps`, one shared namespace `projects`, **shared collections keyed by sanitized entity name** (`patients`, `appointments`, `orders`). Tenant isolation via a mandatory `_projectId` predicate (see Security below), with a secondary index on `_projectId` per collection.
  - **Hybrid escape hatch:** the tenancy layer must support a per-project `isolationTier` (`shared` | `dedicated-scope`). `dedicated-scope` tenants get their own namespace (`prj_<id>`) — an enterprise upsell. **Never provision dedicated top-level containers (buckets/databases)** — they are operationally expensive; namespace-level isolation is the ceiling. The `EntityCollection` resolver decides physical placement from PostgreSQL metadata; callers never know.
  - **Entity storage strategy — `shared-records` is the DEFAULT:** add `EntityStorageStrategy = 'collection' | 'shared-records'` to `EntityDefinition`. Every new entity starts in the generic `records` collection, discriminated by `_entity` + `_projectId`. An entity is **promoted** to a dedicated collection only when it earns it: ~100k+ documents, frequent filtering/sorting on its fields, or high write rate (exact thresholds are a Phase 0 deliverable; promotion must be an online, metadata-driven move). The resolver picks placement from metadata; callers never know. Rationale: AI builders generate long-tail entities (`survey_answers`, `inspection_notes`, `lead_interactions`, …) at 10k projects × 100 entities = 1M logical entities — collection-per-entity collapses operationally even with sharing, so dedicated collections are the exception, not the rule.
  - **Before coding (Phase 0 deliverable):** produce explicit scale calculations comparing Option A (shared collections + `_projectId` discriminator) vs Option B (namespace per project) against the chosen store's documented namespace/collection limits, including the entity-explosion case and the `shared-records` mitigation. Define the heuristic/threshold for when an entity gets `collection` vs `shared-records`. Justify the chosen defaults with numbers.
  - Enforce naming limits — sanitize and length-cap names (`"Patient Records"` → `patient_records`); store the logical → physical mapping in PostgreSQL so user-facing renames never touch physical storage.
- **Isolation security:** with shared collections, the `_projectId` filter is the tenancy boundary. The query compiler must inject it server-side as a mandatory predicate that callers cannot omit or override; add a test proving no code path can produce a query without it.
- Every document carries an envelope:

```json
{
  "_id": "doc_123", "_entity": "patients", "_projectId": "prj_123",
  "_schemaVersion": 4, "_version": 8,
  "_lastEventId": "evt_123", "_eventSequence": 123,
  "_status": "active",
  "_createdAt": "...", "_updatedAt": "...", "_createdBy": "user_123",
  "_deletedAt": null,
  "firstName": "John", "lastName": "Smith"
}
```

  The fields `_id, _entity, _projectId, _schemaVersion, _version, _lastEventId, _eventSequence, _status, _createdAt, _updatedAt, _createdBy, _deletedAt` are **reserved**: user schemas may not define them; reject schemas that try (422). `_version` is optimistic concurrency surfaced from the store's CAS/compare-and-swap mechanism; `_deletedAt` implements soft delete; `_lastEventId` links each document to its latest outbox event, and `_eventSequence` is a per-document monotonic counter — together they make future CDC, replication, and offline/mobile sync cheap to add. `_status` is a lifecycle state — `active` now; the enum (`active | draft | archived | deleted | pending_approval`) is reserved so generated apps can add draft/approval workflows without schema changes.
- Translate `EntityQuery` to the store's parameterized query language **only from a validated filter AST** — field names checked against the entity schema, operators from a whitelist. Never interpolate user input into query strings (`WHERE ${userInput}` must be impossible by construction).
- Also implement a `PostgresDataEngine` fallback (same interface; documents stored in a JSONB column of a per-project table — an internal detail of this provider) selected by `DATA_ENGINE_PROVIDER=nosql|postgres`. This proves the abstraction is real and gives a dev-mode without the NoSQL store.

### 2. NestJS integration (`apps/platform-api/src/modules/data-engine`)

- `DataEngineModule` exposing the `DataEngine` as an injectable, configured from env.
- Hook into project lifecycle in `ProjectsModule`: project create → `provisionTenant` (register tenant + default indexes); project delete → `deprovisionTenant`. Provisioning must be **idempotent and retried** via the existing `queue` module with backoff `1m → 5m → 15m → 1h`. Record provisioning state in PostgreSQL as a state machine: `PENDING → PROVISIONING → READY | FAILED`, and `DELETING → DELETED` for teardown. A NoSQL-store outage during project creation must leave a clean retryable `FAILED` state and never affect control-plane health.
- New Prisma models (proper migrations, never edit applied ones): `DataPlaneProvisioning`, `EntityDefinition`, `EntitySchemaVersion`, `EntityNameMapping`, `DataEngineOutbox`, plus the metadata-layer models from Section 5: `EntityField`, `ValidationRule`, `EntityRule`, skeletal `FormDefinition`, `WorkflowDefinition`, and `SavedDataQuery` (Section 8). First identify the existing `Project`, `ProjectMember`, audit-log, and project-database models and follow their conventions.
- `EntityDefinition` is the **entity registry** — include from day one: `logicalName`, `displayName`, `physicalCollection`, `storageStrategy` (`collection | shared-records`), `provider`, `storageClass` (`standard` now; `hot`/`archive` later without API changes), `schemaVersion`, plus AI-builder provenance: `generatedByAI: Boolean`, `description: String?`, `icon: String?`, `aiPrompt: String?`, `aiReasoning: Json?`, `confidenceScore: Float?`, `sourceWorkbook: String?`, `sourceSheet: String?`. Provenance lets the UI answer "why does this entity exist?" (e.g. *Generated from `crm.xlsx`, sheet "Customers", detected CRM workflow, confidence 0.91*) without another migration on the hottest table — Excel→AI→App provenance is core product value, not telemetry.
- `EntitySchemaVersion` rows carry `version`, **`snapshot: Json` (the complete JSON Schema at that version — never rely on replaying migration scripts to reconstruct state)**, `migrationScript?` (forward migration for breaking changes), and `createdBy` (user id or `"AI"`). Upgrading a document from v3 to v7 reads the v7 snapshot directly, applying migrations only where data transformation is required.
- Add an **`ApplicationModel`** Prisma model now, even if minimally used — and treat it as the **eventual root aggregate**: `EntityDefinition` itself is not the final source of truth. Long-term, `ApplicationModel` owns Entities, Fields, Validations, Forms, Permissions, Workflows, Navigation, Dashboards, and APIs; all of it PostgreSQL metadata, never in the document store. The Data Engine stores application *records* only. A skeletal model (`id`, `projectId`, `name`, `definition: Json`, `version`, timestamps) reserves the seam; Phase 0 must include a short plan for how it will integrate.
- REST API (guarded by existing Keycloak auth + project membership checks, mirroring the `sql` module's authorization pattern):

```
POST   /v1/projects/:projectId/data/:entity            create record
GET    /v1/projects/:projectId/data/:entity            list/query (filter, sort, cursor pagination)
GET    /v1/projects/:projectId/data/:entity/:id        read
PATCH  /v1/projects/:projectId/data/:entity/:id        partial update (If-Match: _version)
PUT    /v1/projects/:projectId/data/:entity/:id        replace
DELETE /v1/projects/:projectId/data/:entity/:id        delete
```

- Validate every write through the full validation pipeline of Section 5 (JSON Schema via `ajv` → field rules → cross-field rules → hooks). Reject unknown entities with 404, validation failures with 422 carrying field-addressable error paths.
- Per-project rate limiting and a max document size (default 1 MB, configurable).

### 3. Cross-store consistency

There are no transactions across PostgreSQL and the NoSQL store. Apply these rules:

- Metadata (schema/entity definitions) lives only in PostgreSQL; documents live only in the NoSQL store. A single logical operation must never require committing to both.
- For flows that touch both (e.g. "create entity type + first record"), write metadata first, then documents; make the document step retryable.
- Implement a **transactional outbox** in PostgreSQL drained by a queue worker, carrying a typed **`DataEngineEvent`** — this is Basefyio's internal event bus, not an ad-hoc callback:

```ts
interface DataEngineEvent {
  id: string;                       // evt_..., written back as _lastEventId
  type: 'document.created' | 'document.updated' | 'document.deleted'
      | 'entity.created' | 'entity.schema.changed';
  projectId: string;
  entity: string;
  documentId?: string;
  schemaVersion: number;
  timestamp: string;
}
```

  Consumers subscribe identically: `realtime`, `search`, `audit` now; `embedding`, `workflow`, `cdc` as registered-but-empty subscribers so adding them later is configuration, not redesign. Do not build vector search now — only reserve the subscriber.
- Soft-delete + scheduled purge for `deprovisionTenant` so accidental project deletion is recoverable for N days.

### 4. Schema evolution (AI-driven)

- Entity JSON Schemas are versioned in PostgreSQL (`entitySchema.version`). Documents store the schema version they were written under.
- Additive changes (new optional field) require no migration. Breaking changes (rename/retype) generate a **lazy migration**: documents are upgraded on read, and a background job sweeps the collection. Never block the API on a full-collection rewrite.
- Expose `POST /v1/projects/:projectId/entities/:entity/schema` for the AI builder to evolve schemas; validate that the new schema is backward-readable or that a migration function is supplied.

### 5. Schema Designer & Validation Engine (metadata layer)

The Data Engine must NOT treat entity schemas as raw JSON Schema only. Generated applications, AI-generated entities, and user-designed entities require a higher-level schema system. JSON Schema is the *compiled output*, not the source of truth — otherwise customer-specific validation logic, form-builder/backend divergence, unexplainable AI rules, and business rules leaking into documents follow within months.

The metadata hierarchy is:

```
Application Model → Entity Model → Field Model → Validation Rules → Document Store
```

Introduce a field-level model in PostgreSQL metadata:

```ts
type FieldKind = 'scalar' | 'object' | 'array' | 'lookup' | 'attachment';

type ScalarType = 'text' | 'longText' | 'number' | 'currency' | 'boolean'
                | 'date' | 'datetime' | 'email' | 'phone' | 'url' | 'json'
                | 'multiLookup';

interface EntityField {
  id: string;
  name: string;
  displayName: string;
  kind: FieldKind;
  type?: ScalarType;              // when kind === 'scalar'
  required: boolean;
  unique: boolean;
  validationRules: ValidationRule[];
  children?: EntityField[];       // when kind === 'object'
  itemSchema?: EntityField;       // when kind === 'array'
  ui?: UiFieldConfig;
}

interface ValidationRule {
  id: string;
  type: 'required' | 'minLength' | 'maxLength' | 'regex' | 'email' | 'phone'
      | 'minValue' | 'maxValue' | 'lookupExists' | 'customExpression';
  config: Json;
}

interface EntityRule {              // cross-field / business rules
  id: string;
  trigger: 'beforeCreate' | 'beforeUpdate';
  expression: string;               // e.g. endDate >= startDate,
                                    // discount <= totalAmount,
                                    // status: approved → draft forbidden
  errorMessage: string;
}
```

- The JSON Schema snapshot in `EntitySchemaVersion` is **generated** from `EntityField` definitions (a deterministic compiler), never hand-edited. Field model changes produce a new schema version through the existing versioning path.
- Validation execution pipeline on every write, in order: **JSON Schema validation → field ValidationRules → cross-field EntityRules → entity hooks → document write.** Each stage returns structured, field-addressable errors (422 with paths) so the form builder can render them.
- `customExpression` and `EntityRule.expression` use a sandboxed, side-effect-free expression language (no `eval`); document the grammar. Expressions are data, stored in PostgreSQL — never code, never inside documents.
- These rules are consumed later by the Application Model for: form builder, AI-generated applications, approval workflows, dynamic page generation, mobile app generation, and API validation. The document store remains responsible only for records; **business rules belong to metadata.**

**Future-proofing — reserve these PostgreSQL metadata models now** (skeletal is fine): `EntityField`, `ValidationRule`, `EntityRule`, `FormDefinition`, `WorkflowDefinition`. None of their content is ever stored inside the NoSQL document store. This keeps Basefyio evolving toward *Excel → AI Understanding → Application Model → Runtime* rather than becoming a generic JSON document database.

### 6. Hierarchical / Nested Document Schema Design

The Data Engine must support both relational-style flat records and **document-native nested records**. The schema designer must not flatten every structure into SQL-style columns — that would forfeit the entire point of a document data plane. Required shapes: object inside object, arrays of objects, repeatable sections, embedded child records, mixed structured + semi-structured fields (optional flexible JSON blocks for advanced users), all with schema-defined nesting limits and UI generation from nested schemas.

The `EntityField` model above already carries the shape (`kind`, `children`, `itemSchema`). Example document:

```json
{
  "customer": {
    "name": "ACME",
    "address": { "city": "New York", "country": "US" }
  },
  "contacts": [
    { "name": "Jane", "email": "jane@acme.com" }
  ]
}
```

**Schema designer (Admin UI + AI builder)** must support designing: flat entities (`Customer`), nested objects (`Customer.address`), repeatable embedded sections (`Customer.contacts[]`), arrays of scalars (`tags[]`), arrays of objects (`lineItems[]`). Nested paths are always displayed explicitly: `customer.address.city`, `contacts[].email`, `lineItems[].quantity`.

**Validation at every level** — root document, nested object, array item, deeply nested field, and cross-field rules via **safe path references** (never raw JavaScript execution): `billingAddress.country` required; `contacts[].email` valid email; `lineItems[].quantity > 0`; `shippingAddress.country == billingAddress.country when sameAddress=true`. Errors return the full nested path so forms can render them in place.

**Query AST on nested paths.** Filters address nested fields (`{ field: "customer.address.city", op: "eq", value: "New York" }`) and arrays via explicit operators (`{ field: "contacts[].email", op: "contains", value: "jane@acme.com" }`). The query compiler validates **every** nested path against the entity schema before producing a provider query; arbitrary user-supplied paths must never reach a raw query string.

**Indexes on nested paths**, only for schema-declared paths:

```ts
interface IndexDef {
  name: string;
  fields: Array<{ path: string; order?: 'asc' | 'desc' }>;
  partialFilter?: Filter;
}
```

The system should recommend indexes from actual query usage (collect query-shape stats; surfacing recommendations can be a later phase, but record the stats now).

**Embed vs. separate-entity rule.** Nested data stays embedded when it shares the parent's lifecycle (addresses, contact methods, line items, settings, survey answers, form sections, metadata blocks). Promote to a separate entity with a `lookup` relationship when the child has its own lifecycle, needs its own permissions, is queried independently at high volume, is referenced by many parents, or needs workflows/audit history.

**AI schema design provenance.** The AI builder must choose embedded-object vs embedded-array vs separate-entity-with-lookup for every structure, and store the decision + reason in PostgreSQL metadata:

```json
{
  "field": "lineItems",
  "decision": "embedded-array",
  "reason": "Line items belong to the order lifecycle and are usually read together with the order."
}
```

**UI generation** from nested schemas: nested field groups, collapsible object sections, repeatable array sections, table-style editors for arrays of objects, validation messages at nested paths, read-only computed nested fields. Generated mobile apps consume the same nested schema model.

**Limits** (configurable; reject schemas over depth, reject writes over size/array limits):

```
DATA_ENGINE_MAX_NESTING_DEPTH=8
DATA_ENGINE_MAX_ARRAY_ITEMS=1000
DATA_ENGINE_MAX_DOC_KB=1024
```

**Non-goal:** do not convert the NoSQL data plane into a relational ORM. The point is document-native flexibility with schema, validation, permissions, and application metadata still controlled by Basefyio.

### 7. Mobile-First Hierarchical Data Model

**Locked principle: Basefyio must not be a table generator. It must be an application-model generator with a document-native data plane.** Generated mobile apps (feeds, marketplaces, delivery, CRM, field-service, social/community) need the backend to return **screen-ready document shapes**, not flat rows: nested profiles, embedded media metadata, feed cards with author/stats/viewer state, comments with preview replies, per-user personalization, offline sync metadata, localized content.

**Mobile schema primitives.** Extend `FieldKind` with metadata primitives (all defined in PostgreSQL metadata; they compile to JSON Schema, API validation, SDK types, and UI/mobile components):

```ts
type FieldKind =
  | 'scalar' | 'object' | 'array' | 'lookup' | 'attachment'   // existing
  | 'media'          // url + dimensions/duration/aspect metadata
  | 'relation'       // alias surface for lookup with mobile semantics
  | 'computed'       // read-only, derived server-side
  | 'counter'        // likes/views — incremented via events, not document rewrites
  | 'localizedText'  // per-locale values
  | 'viewerState'    // per-requesting-user state, filled at projection time, never stored in the document
  | 'syncState';     // offline-sync metadata, paired with _version/_eventSequence
```

`counter` fields are updated through the outbox/event path (atomic increments), never by full-document replace — this is what keeps like/view counts cheap. `viewerState` is **virtual**: it exists in the schema and SDK types but is computed per request from relation data; storing it inside the document is a design error the validator must reject.

**Feed-ready projection layer.** A projection is a named read model derived from documents + metadata — never a new source of truth:

```ts
interface AppProjection {
  id: string;
  projectId: string;
  name: string;                  // e.g. "mobileFeedCard"
  sourceEntity: string;          // e.g. "videos"
  shape: JsonObject;             // output shape, schema-validated
  includes: ProjectionInclude[]; // relation/author/media joins resolved server-side
  computedFields: ComputedField[];
  cachePolicy: 'none' | 'short' | 'feed' | 'offline';
}
```

Generated apps call `GET /v1/projects/:projectId/views/:projection` (e.g. `views/mobileFeedCard`) instead of client-side joins. Projections live in PostgreSQL metadata; the projection resolver enriches documents with relation lookups and per-user `viewerState` at read time. Same auth/membership guards as `/data/*`.

**Embed vs relation vs projection decision rules** (the AI schema designer must choose and record provenance for each):

- **Embed** when data is read together, lifecycle belongs to parent, item is small, permissions match the parent, and offline cache benefits from one document.
- **Relation** when the child has independent permissions, grows unbounded, is queried independently, has its own workflow, or is shared across parents.
- **Projection** when a mobile screen needs a combined shape (feed card = author + media + stats + viewerState), denormalized read performance matters, or offline-first cache needs screen-ready documents.

**Mobile Screen Models** in the `ApplicationModel` aggregate:

```ts
interface MobileScreenModel {
  id: string;
  name: string;
  route: string;
  type: 'feed' | 'detail' | 'form' | 'profile' | 'settings'
      | 'search' | 'chat' | 'notifications';
  dataSource: { type: 'entity' | 'projection'; name: string };
  layout: JsonObject;
  actions: MobileAction[];
}
```

The Data Engine must expose enough metadata for mobile generators to build feed, detail, profile, nested-form, media-upload, comment/reply screens, offline cache, and sync-conflict UI. The envelope's `_version` + `_eventSequence` are the offline-sync backbone.

**Phase 0 deliverable — TikTok-style modeling comparison.** Produce a design document modeling a TikTok-like app in Basefyio (entities: `users`, `videos`, `comments`, `follows`, `reactions`, `notifications`, `moderation_events`), with a video document carrying `authorSnapshot`, `media`, `hashtags`, `stats` (counter fields), `moderation`; and a `mobileFeedCard` projection adding per-user `viewerState`. Compare flat-SQL vs document-native for: user profile, video post, feed card, comments (hybrid: top-level entity + embedded preview replies), likes/views (counters + event stream, not aggregate tables), viewer state (projection enrichment, not per-user joins), offline cache (envelope + version + event sequence), UI generation (schema paths → mobile components). The conclusion must be explicit: Basefyio does not copy TikTok's internal architecture; it proves a TikTok-like product is modeled naturally with document records, nested schemas, embedded media, relations, projections, event/outbox counters, viewer state, and sync metadata — without custom backend code.

### 8. Data Engine Query Layer — two modes (SQL-like + Aggregation)

The Admin UI Data tab offers exactly **two query modes** (`Data → Query` with a `SQL-like` / `Aggregation` toggle). Both are user-friendly *input languages only* — vendor-neutral, never raw provider syntax. Both compile to Basefyio's own validated ASTs; the provider compiles those into parameterized execution inside the Data Engine provider only. **Key point: a familiar pipeline-style user experience, but never a vendor-native execution surface.**

**Naming lock — aggregation is a Basefyio DSL, not provider native.** The UI label may say *Aggregation*; the internal name is *Data Engine Aggregation*; the implementation name is **Basefyio Aggregation DSL**. The word "native" (and "raw", "provider aggregation", "NoSQL-native") must NOT appear in code identifiers, API names, schema, SDK methods, docs headings, commits, or internal interfaces — it implies provider-native execution and invites abstraction leakage. Concretely: `mode: 'aggregation'`, never `mode: 'native-aggregation'`. Forbidden phrases: *native query, native aggregation API, provider aggregation, raw aggregation, NoSQL-native aggregation*. Add a CI repository scan that fails on these phrases outside explanatory test fixtures.

Both modes share one execution boundary:

```
User query text → Parser → Validated Basefyio AST
  → _projectId injection → Permission checks
  → Provider parameterized compiler → Paged result
```

**Mandatory rules for both modes:** user query text never reaches the provider; `_projectId` is injected server-side and cannot be selected, matched, grouped, projected, or overridden; entity names and nested paths validated against PostgreSQL metadata; operators allowlisted; execution time, page size, and document size limits enforced server-side even if omitted; provider-specific features hidden behind `capabilities()`.

#### Mode 1 — SQL-like (Data Engine SQL)

For users who know SQL. Restricted SELECT-only dialect compiling to the canonical `EntityQuery`:

```sql
SELECT _id, customer.name, customer.address.city
FROM customers
WHERE customer.address.city = 'New York'
ORDER BY _updatedAt DESC
LIMIT 50
```

Nested and array paths supported: `contacts[].email CONTAINS 'jane@acme.com'`, `lineItems[].quantity > 0`. No INSERT/UPDATE/DELETE/DDL, no joins, no subqueries, no provider functions, no arbitrary expressions. Parameter binding mandatory (`?` + `params`).

Parser contract (Phase 1):

```ts
interface DataEngineSqlQuery {
  select: PathRef[];
  from: EntityName;
  where?: Filter;
  orderBy?: Sort[];
  limit?: number;
  cursor?: string;
}
```

#### Mode 2 — Aggregation (Basefyio Aggregation DSL)

For users who understand document databases and want pipeline-style querying. Familiar to NoSQL users, but it is a Basefyio-owned, provider-neutral DSL compiling to the `EntityAggregation` AST:

```json
[
  { "$match": { "customer.address.city": "New York" } },
  { "$unwind": "$lineItems" },
  { "$group": {
      "_id": "$lineItems.productId",
      "totalQuantity": { "$sum": "$lineItems.quantity" }
  }},
  { "$sort": { "totalQuantity": -1 } },
  { "$limit": 20 }
]
```

Contract (Phase 1):

```ts
type AggregationStage =
  | MatchStage | ProjectStage | UnwindStage
  | GroupStage | SortStage | LimitStage | SkipStage;

interface EntityAggregation {
  entity: string;
  pipeline: AggregationStage[];
  cursor?: string;
}
```

- **Allowed V1 stages:** `$match`, `$project`, `$unwind`, `$group`, `$sort`, `$limit`, `$skip`.
- **Allowed V1 accumulators:** `$count`, `$sum`, `$avg`, `$min`, `$max`.
- **Blocked V1:** `$lookup`, `$out`, `$merge`, `$function`, `$where`, `$accumulator`, provider-specific stages, raw JavaScript. `$lookup` is blocked deliberately — relationships go through Application Model projections (Section 7), not arbitrary cross-entity joins. Blocked stages fail with clear validation errors.

#### API

```
POST /v1/projects/:projectId/data-query/sql
POST /v1/projects/:projectId/data-query/aggregation
POST /v1/projects/:projectId/data-query/explain
```

SQL request: `{ "sql": "SELECT _id, customer.name FROM customers WHERE customer.address.city = ? LIMIT 50", "params": ["New York"] }`. Aggregation request: `{ "entity": "orders", "pipeline": [...] }`. Responses are paged (`columns`/`rows` or grouped docs + `page.nextCursor`).

#### Admin UI requirements

Mode toggle, syntax highlighting for both modes, schema-path autocomplete, saved queries, parameter editor, result grid + JSON result view, explain panel, index recommendation panel, execution time / row count / warning badges.

#### Explain mode (both modes)

Shows: query mode, entity, selected/projected paths, filter paths, unwind paths, group keys, sort fields, whether matching indexes exist, recommended indexes, estimated query risk (low/medium/high), and whether nested paths/arrays are used. Never exposes provider-specific query text.

#### Saved queries (both modes, PostgreSQL metadata only)

```ts
interface SavedDataQuery {
  id: string; projectId: string; name: string;
  mode: 'sql' | 'aggregation';
  entity?: string;
  sql?: string;
  pipeline?: Json;
  paramsSchema?: JsonObject;
  createdBy: string; createdAt: string;
}
```

### 9. Infrastructure

- Add to `docker-compose.yml` and `docker-compose.prod.yml`: a `nosql` service (the chosen store's official image, healthcheck, named volume, memory quotas from env) plus a `nosql-init` one-shot service that (1) waits for cluster readiness, (2) initializes required services, (3) creates the `basefyio-apps` container/namespace, (4) applies baseline indexes.
- Env vars (document in `.env.example`): `DATA_ENGINE_PROVIDER`, `NOSQL_CONNSTR`, `NOSQL_USERNAME`, `NOSQL_PASSWORD` (no vendor name — these are fine), `DATA_ENGINE_CONTAINER`, `DATA_ENGINE_NAMESPACE`, `DATA_ENGINE_MAX_DOC_KB`, `DATA_ENGINE_MAX_NESTING_DEPTH`, `DATA_ENGINE_MAX_ARRAY_ITEMS`. In user-facing docs, the heading is "NoSQL store connection" — never the chosen store's name.
- Extend the `kb` CLI (`packages/cli`) so `kb start` brings up the NoSQL store and waits for readiness; `kb status` reports Data Engine health.
- Add a `/health` contribution: Data Engine ping (container reachable, query service responsive).

### 10. SDK + Admin UI

- `packages/sdk`: typed `db.collection('<entity>')` client with `insert/get/update/delete/query` mapping to the REST API above, plus `db.view('<projection>')` for the projection layer. Generated types preserve nested shapes (objects, arrays, media, counters, virtual viewerState). Keep the call shape Supabase-like to match existing SDK conventions.
- `apps/admin-ui`: a "Data" tab per project — entity list (from PG metadata), document browser with filter/sort/pagination, JSON editor for single documents, and a read-only "engine: Basefyio Data Engine" label (never the vendor name).

### 11. Tests & docs

- Unit tests: query translation (EntityQuery → provider query, incl. nested-path and array operators), envelope handling, schema validation at all nesting levels, path validation against schema, name sanitization, nesting-depth/array/size limit enforcement.
- Integration tests against the real NoSQL store via Testcontainers: provision → CRUD → query → concurrent CAS conflict → deprovision. Same suite must pass against `PostgresDataEngine` (contract tests).
- Load smoke test: 10k inserts + paginated scan per tenant within agreed latency budget.
- Docs: `md/data-engine.md` (architecture, tenancy mapping, consistency rules, runbook for NoSQL node failure and rebalance).

## Constraints

- Do not break any existing module; existing per-project PostgreSQL databases and the `sql` module continue to work unchanged.
- Follow existing codebase conventions (NestJS module layout, Prisma migration workflow, existing auth guards).
- TypeScript strict mode; no `any` in the Data Engine public interface.
- All new Prisma models via proper migrations; never edit applied migrations.
- Parameterize every query; treat entity names and field names from users as untrusted input.

## Phased Execution Plan

1. **Phase 0 — Recon + design review (mandatory gate).** Study `projects`, `sql`, `auth`, `queue`, `realtime`, `search` modules and the `kb start`/`kb stop`/`kb status` extension points in `packages/cli`. Produce ALL of the following, then **stop and wait for approval before writing any code**:
   1. Codebase reconnaissance: lifecycle events, membership checks, existing patterns for queues, retries, audit logs, auth guards, rate limiting, health checks — the Data Engine must reuse these, not reinvent them.
   2. Provisioning flow analysis (how per-project Postgres/Keycloak provisioning works today; how the data plane mirrors it).
   3. Queue integration analysis (which queue infra the outbox drainer and retry/backoff reuse).
   4. NoSQL store selection (against the requirements in the vendor-neutrality rule) + namespace/collection scaling calculations against its documented limits (Option A vs B).
   5. Entity-explosion calculations (projects × entities, long-tail distribution assumptions).
   6. Concrete `collection` vs `shared-records` promotion thresholds, weighing query patterns and index needs, not just row counts.
   7. Outbox architecture diagram (write path → outbox → subscribers, incl. reserved `embedding`/`workflow`/`cdc`).
   8. `ApplicationModel` integration plan (how app-model metadata will consume EntityDefinitions later).
   9. TikTok-style mobile modeling comparison per Section 7 (flat-SQL vs document-native table, sample entity set, video document + feed projection shapes, explicit conclusion).
2. **Phase 1 — Metadata Contract + Data Engine Interfaces (contracts only, no provider code).** The nested/mobile schema system is foundational, NOT a later layer — implementing flat CRUD first and adding nesting/projections later breaks the provider, API, and SDK contracts twice. Define and compile, with type-level tests: `DataEngine`, `EntityCollection`, `EntityField` (incl. nested `object`/`array` shapes and mobile primitives `media`/`counter`/`viewerState`/`localizedText`/`syncState`), `EntityRule`, `ValidationRule`, `EntityQuery`, `Filter`, `PathRef` (safe nested-path references), `IndexDef` (nested paths), `AppProjection`, `MobileScreenModel`, `DataEngineSqlQuery` and `EntityAggregation`/`AggregationStage` (the two query-mode parser contracts, Section 8), embed-vs-relation-vs-projection decision metadata, the JSON Schema compiler contract, and the validation pipeline contract. **No provider implementation is allowed until these compile.**

   **🚧 HARD GATE — TikTok fixture.** Before any provider code: encode the Section 7 TikTok-like model as executable fixture data (`users`, `videos`, `comments`, `reactions`, `follows`, `mobileFeedCard` projection, nested `media` object, counters, virtual `viewerState`, offline sync fields, nested validation errors) and prove the type system represents it — fixtures must type-check against the Phase 1 contracts and round-trip through the schema compiler. This is the mechanical guard against the implementation collapsing into a flat table API.

3. **Phase 2 — Provider Contract Tests (before providers exist).** Write the provider-agnostic suite first: flat CRUD; nested-object CRUD; array-of-objects CRUD; nested-path filter; array-path filter; invalid-path rejection; schema validation at nested paths; mandatory `_projectId` injection; CAS conflict; soft delete; projection shape contract; aggregation pipeline execution (`$match`/`$unwind`/`$group`/`$sort` on nested paths) and blocked-stage rejection. These tests define what "a provider" means.
4. **Phase 3 — Providers.** Implement `NoSqlDataEngine` and `PostgresDataEngine` against the same contract suite. The Postgres provider must support the same nested-path semantics (JSONB path operators) wherever possible; genuinely unsupported capabilities are declared via `capabilities()` and skipped *explicitly* in tests — never silently.
5. **Phase 4 — Platform API + Metadata Models.** Prisma metadata models, REST endpoints (incl. `/views/:projection` and `/data-query/sql|aggregation|explain` with both parsers), validation pipeline execution, authz, rate limits, outbox events, provisioning state machine, docker-compose/CLI/health checks, schema evolution + lazy migrations.
6. **Phase 5 — Schema Designer UI + SDK.** Build Admin UI (nested designer, repeatable sections, two-mode Data → Query editor with EXPLAIN, saved queries) and SDK (nested types, `db.view()`) **from the metadata contract, not from provider-specific behavior.**
7. **Phase 6 — Hardening:** load test, failure-mode tests (NoSQL store down → API returns 503 with retry-after, control plane unaffected), docs, runbook.

After each phase: run the full test suite, run `graphify update .` if available, and summarize what changed and what's next.

## Acceptance Criteria

- A new project gets a working document data plane automatically within seconds of creation; failure leaves a clean `FAILED` state, retryable.
- CRUD + query on generated entities works end-to-end via REST and SDK, multi-tenant isolated: a token for project A can never read project B's data, in both shared-collection and dedicated-scope tiers — prove with tests, including one showing the query compiler cannot emit a query lacking the `_projectId` predicate.
- Switching `DATA_ENGINE_PROVIDER=postgres` passes the identical contract test suite, with capability-gated tests skipped per `capabilities()`.
- Phase 0 scale model exists and the implemented tenancy defaults match its conclusions.
- Business rules, validation rules, form/workflow definitions, and AI provenance live exclusively in PostgreSQL metadata; a sweep of stored documents shows only record data and reserved envelope fields — no rules, no UI config, no schema fragments.
- The JSON Schema for any entity is reproducible by recompiling its `EntityField` definitions (compiler is deterministic; test enforces snapshot == compile(fields)).
- Nested-path queries and validations work end-to-end (filter on `customer.address.city`, array operator on `contacts[].email`, validation error surfaced at a nested path), and the query compiler rejects any path not declared in the entity schema.
- Nested schemas are first-class in `EntityDefinition` and `ApplicationModel`; the Admin UI schema designer handles nested objects and repeatable sections; SDK types preserve nested shapes.
- Mobile Screen Models can source from entities or projections; `GET /views/:projection` returns the declared shape with relation includes and per-user `viewerState` resolved; `counter` fields increment via events without document rewrites; the validator rejects `viewerState` stored in documents.
- The AI builder records an embed-vs-relation-vs-projection decision with reason for every structure it generates.
- The Phase 0 TikTok-style feed model is representable without custom backend code (entities + projections + counters only), and the Phase 1 hard-gate fixture type-checks against the contracts and round-trips through the schema compiler — kept in CI permanently as a regression guard.
- The contract test suite (Phase 2) predates both providers in git history; neither provider has tests of its own that contradict or bypass the shared suite.
- Query layer: the UI offers exactly two modes — SQL-like compiling to `EntityQuery`, Aggregation (Basefyio Aggregation DSL) compiling to `EntityAggregation`; neither mode sends raw user query text to a provider; nested paths and arrays work in both; `_projectId` injection cannot be bypassed in either (not selectable, matchable, groupable, or projectable); blocked stages/operators fail with clear validation errors; the same saved-query metadata model (`mode: 'sql' | 'aggregation'`) supports both; the same query passes against both providers; EXPLAIN recommends indexes without leaking provider-specific syntax.
- No code, docs, API schema, SDK method, or UI string describes aggregation as provider-native or raw; the CI repository scan for forbidden phrases (*native query, native aggregation, provider aggregation, raw aggregation, NoSQL-native*) passes, with exceptions only for explanatory test fixtures.
- The NoSQL store being down degrades only the data plane (503 on `/data/*`), never auth, billing, projects, or SQL features.
- Zero occurrences of the chosen store's vendor name (case-insensitive) outside `packages/data-engine/providers/nosql/` — including user-facing strings, API routes, SDK public API, env vars, and docs.
- **No abstraction leakage:** no code outside `packages/data-engine` may import the store's SDK or touch provider-specific objects (cluster/bucket/scope/collection handles, raw query APIs). Enforce mechanically — ESLint `no-restricted-imports` (or dependency-boundary rules) in CI plus an architecture test that fails on violation — not by convention.
