# Basefyio Data Engine — Developer Documentation

> Version: 0.1.0 | Last updated: 2026-06-09

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Package Structure](#2-package-structure)
3. [Interfaces & Type System](#3-interfaces--type-system)
4. [Document Envelope](#4-document-envelope)
5. [Providers](#5-providers)
6. [Tenancy Model](#6-tenancy-model)
7. [Schema System](#7-schema-system)
8. [Validation Pipeline](#8-validation-pipeline)
9. [Query Layer](#9-query-layer)
10. [REST API Reference](#10-rest-api-reference)
11. [SDK Usage](#11-sdk-usage)
12. [Event System & Outbox](#12-event-system--outbox)
13. [Prisma Models](#13-prisma-models)
14. [NestJS Integration](#14-nestjs-integration)
15. [Provisioning Lifecycle](#15-provisioning-lifecycle)
16. [Docker Setup](#16-docker-setup)
17. [Configuration](#17-configuration)
18. [Testing](#18-testing)
19. [Vendor Neutrality Rules](#19-vendor-neutrality-rules)
20. [Runbook](#20-runbook)

---

## 1. Architecture Overview

```
SDK / Admin UI / Generated Apps
              |
        Platform API (NestJS)
              |
      DataEngineModule (injectable)
              |
        @basefyio/data-engine
              |
      DataEngine interface
          /          \
   PostgreSQL       NoSQL store
   (JSONB)          (vendor-confined)
```

**PostgreSQL remains the system of record** for: users, teams, projects, billing, permissions, audit logs, entity definitions, schema versions, application models, and all metadata.

**The NoSQL store is the application data plane** for: generated application records, form submissions, AI-generated schema instances, and user content.

**Hard rule:** No module outside `packages/data-engine/providers/nosql/` may import the NoSQL store's SDK. All document access goes through the `DataEngine` abstraction.

---

## 2. Package Structure

```
packages/data-engine/
├── src/
│   ├── interfaces/
│   │   ├── data-engine.ts      # DataEngine + EntityCollection interfaces + error classes
│   │   ├── query.ts            # Filter AST, EntityQuery, Aggregation DSL, PathRef, IndexDef
│   │   ├── schema.ts           # EntityField, ValidationRule, EntityRule, Projection, Mobile
│   │   └── types.ts            # Document envelope, tenancy, capabilities, events, config
│   ├── providers/
│   │   ├── nosql/
│   │   │   ├── nosql-engine.ts     # NoSQL store provider (vendor-confined)
│   │   │   └── couchbase-types.ts  # Vendor SDK type stubs
│   │   └── postgres/
│   │       └── postgres-engine.ts  # PostgreSQL JSONB fallback provider
│   ├── tenancy/
│   │   ├── names.ts            # Name sanitization, scope naming
│   │   └── provisioning.ts     # State machine, retry backoff
│   ├── validation/
│   │   └── schema.ts           # JSON Schema compiler, reserved field checker
│   ├── query/                  # (reserved for query parsers — Phase 2)
│   ├── __fixtures__/
│   │   ├── tiktok-model.ts     # CI regression guard — TikTok app fixture
│   │   └── schema-compiler-test.ts
│   ├── __tests__/
│   │   ├── schema-compiler.test.ts
│   │   ├── tenancy-names.test.ts
│   │   └── provider-contract.test.ts  # Shared contract suite
│   └── index.ts                # Public API + provider factory
├── package.json
├── tsconfig.json
└── jest.config.ts
```

---

## 3. Interfaces & Type System

### DataEngine (top-level)

```typescript
interface DataEngine {
  provisionTenant(projectId: string, tier?: IsolationTier): Promise<TenantDataPlane>;
  deprovisionTenant(projectId: string): Promise<void>;
  collection(projectId: string, entity: string): EntityCollection;
  capabilities(): ProviderCapabilities;
  ping(): Promise<boolean>;
  aggregate(projectId: string, aggregation: EntityAggregation): Promise<Page<JsonObject>>;
  explain(projectId: string, query: EntityQuery | EntityAggregation): Promise<QueryExplainResult>;
}
```

### EntityCollection (per-entity operations)

```typescript
interface EntityCollection {
  insert(doc: JsonObject, opts?: WriteOpts): Promise<DocResult>;
  get(id: string): Promise<DocResult | null>;
  update(id: string, patch: JsonObject, opts?: WriteOpts): Promise<DocResult>;
  replace(id: string, doc: JsonObject, opts?: WriteOpts): Promise<DocResult>;
  delete(id: string, opts?: WriteOpts): Promise<void>;
  query(q: EntityQuery): Promise<Page<DocResult>>;
  count(filter?: Filter): Promise<number>;
  ensureIndexes(defs: IndexDef[]): Promise<void>;
}
```

### ProviderCapabilities

Callers must branch on capabilities, **never on provider name**:

```typescript
// CORRECT:
if (engine.capabilities().fullTextSearch) { ... }

// FORBIDDEN (will fail CI lint):
if (provider === 'nosql') { ... }
```

### Error Classes

| Error | HTTP | When |
|-------|------|------|
| `DocumentNotFoundError` | 404 | Document doesn't exist or is soft-deleted |
| `ConcurrencyError` | 409 | `ifMatch` version doesn't match current |
| `EntityNotFoundError` | 404 | Entity not registered in metadata |
| `SchemaValidationError` | 422 | Document fails schema validation |
| `TenantNotProvisionedError` | 503 | Data plane not ready for this project |
| `QueryValidationError` | 400 | Invalid filter, path, or operator |
| `DocumentTooLargeError` | 413 | Document exceeds `DATA_ENGINE_MAX_DOC_KB` |

---

## 4. Document Envelope

Every stored document carries these reserved fields:

```json
{
  "_id": "patients::550e8400-e29b-41d4-a716-446655440000",
  "_entity": "patients",
  "_projectId": "prj_abc123",
  "_schemaVersion": 3,
  "_version": 12,
  "_lastEventId": "evt_xyz789",
  "_eventSequence": 12,
  "_status": "active",
  "_createdAt": "2026-06-09T10:00:00.000Z",
  "_updatedAt": "2026-06-09T15:30:00.000Z",
  "_createdBy": "user_456",
  "_deletedAt": null,
  "firstName": "John",
  "lastName": "Smith"
}
```

**Reserved field rules:**
- User schemas MUST NOT define fields starting with `_`. The system rejects them with HTTP 422.
- `_version` is the optimistic concurrency token. Use `WriteOpts.ifMatch` to enable CAS.
- `_status` lifecycle: `active` → `draft` → `archived` → `deleted` → `pending_approval`.
- `_deletedAt` is set on soft-delete. Default queries exclude soft-deleted documents.
- `_eventSequence` is a monotonic counter per document — used for offline sync.

---

## 5. Providers

### PostgreSQL Provider (`DATA_ENGINE_PROVIDER=postgres`)

- Documents stored in `data_engine.records` table (JSONB column)
- Table created automatically on `provisionTenant()`
- Filters compiled to JSONB operators (`->>'path'`, `@>`, `?`)
- CAS via `version` column + conditional UPDATE
- GIN index on `data` column for general queries
- Expression indexes for specific field paths via `ensureIndexes()`

**When to use:** Local development, CI, small-scale deployments where adding a NoSQL store isn't justified.

### NoSQL Store Provider (`DATA_ENGINE_PROVIDER=nosql`)

- Documents stored in the NoSQL store cluster
- Uses vendor's SDK (imported ONLY in `providers/nosql/`)
- Filters compiled to N1QL (parameterized, never string-interpolated)
- CAS via the store's native compare-and-swap mechanism
- Secondary GSI indexes via `ensureIndexes()`
- Full-text search capability available

**When to use:** Production deployments requiring high-throughput document workloads.

### Adding a New Provider

1. Create `packages/data-engine/src/providers/<name>/<name>-engine.ts`
2. Implement the `DataEngine` interface
3. Add the provider to the factory in `src/index.ts`
4. Run the shared contract test suite against your provider
5. The vendor SDK MUST NOT be imported outside the provider directory

---

## 6. Tenancy Model

### Physical Layout (NoSQL Store)

```
Container: basefyio-apps (1 per cluster)
  Namespace: projects (shared, default)
    Collection: records         ← shared-records (DEFAULT for all entities)
    Collection: patients        ← promoted entity (high-volume)
    Collection: orders          ← promoted entity
  Namespace: prj_abc123         ← dedicated-scope tenant (enterprise)
    Collection: records
```

### Isolation Tiers

| Tier | Physical Layout | Use Case |
|------|----------------|----------|
| `shared` (default) | Shared namespace, `_projectId` discriminator | 99% of projects |
| `dedicated-scope` | Own namespace within the same container | Enterprise upsell |

### Entity Storage Strategy

| Strategy | Where Stored | When Used |
|----------|-------------|-----------|
| `shared-records` (default) | `records` collection, discriminated by `_entity` + `_projectId` | All new entities |
| `collection` (promoted) | Dedicated collection named after the entity | High-volume entities (>100k docs, >50 w/s, >3 indexes) |

**Why shared-records is the default:** At scale (10k projects × 100 entities = 1M logical entities), creating a collection per entity exceeds store limits. The shared-records strategy keeps the collection count manageable.

**Promotion** is an online, metadata-driven move. Callers never know whether an entity is in `records` or its own collection — the resolver handles it.

### Security: Mandatory `_projectId` Injection

The query compiler injects `_projectId = <projectId>` as a mandatory predicate on every query. This filter:
- Is added server-side
- Cannot be omitted by callers
- Cannot be overridden by user-supplied filters
- Is verified by the provider contract test suite

---

## 7. Schema System

### Hierarchy

```
ApplicationModel (root aggregate, skeletal)
  └── EntityDefinition
        ├── EntityField[] (field model — source of truth)
        │     └── ValidationRule[]
        ├── EntityRule[] (cross-field business rules)
        └── EntitySchemaVersion[] (compiled JSON Schema snapshots)
```

### EntityField

```typescript
interface EntityField {
  id: string;
  name: string;
  displayName: string;
  kind: FieldKind;        // scalar, object, array, lookup, media, counter, viewerState, ...
  type?: ScalarType;      // text, number, email, date, boolean, ...
  required: boolean;
  unique: boolean;
  indexed: boolean;
  validationRules: ValidationRule[];
  children?: EntityField[];     // for 'object' kind
  itemSchema?: EntityField;     // for 'array' kind
  ui?: UiFieldConfig;
  defaultValue?: JsonValue;
  lookupEntity?: string;        // for 'lookup' kind
  computeExpression?: string;   // for 'computed' kind
  counterInitial?: number;      // for 'counter' kind
  locales?: string[];           // for 'localizedText' kind
}
```

### FieldKind Reference

| Kind | Description | Stored in Document? |
|------|-------------|-------------------|
| `scalar` | Simple value (text, number, boolean, date, email, ...) | Yes |
| `object` | Nested object with `children` fields | Yes |
| `array` | Array with `itemSchema` defining element type | Yes |
| `lookup` | Reference to another entity (stores ID) | Yes |
| `attachment` | File reference (url, mimeType, size) | Yes |
| `media` | Rich media (url, dimensions, duration, aspect ratio) | Yes |
| `relation` | Alias for lookup with mobile semantics | Yes |
| `computed` | Derived server-side, read-only | No (computed at read) |
| `counter` | Likes/views — incremented via events | Yes (but via events, not rewrites) |
| `localizedText` | Per-locale string values | Yes |
| `viewerState` | Per-user state (liked, saved, following) | **No** (virtual, projection-time) |
| `syncState` | Offline sync metadata | Yes |

### JSON Schema Compiler

```typescript
import { compileFieldsToJsonSchema } from '@basefyio/data-engine';

const schema = compileFieldsToJsonSchema(entity.fields);
// Deterministic: same input always produces the same output
// Stored as EntitySchemaVersion.snapshot
```

The compiler is the single source of truth for JSON Schema. Hand-editing snapshots is forbidden.

---

## 8. Validation Pipeline

On every document write, in order:

1. **JSON Schema validation** — `ajv` validates against the compiled schema snapshot
2. **Field ValidationRules** — Per-field rules (minLength, maxLength, regex, email, phone, minValue, maxValue, lookupExists, customExpression)
3. **Cross-field EntityRules** — Business rules (e.g. `endDate >= startDate`)
4. **Entity hooks** — (reserved for future use)
5. **Document write** — If all pass, write to the store

Each stage returns structured, field-addressable errors:

```json
{
  "statusCode": 422,
  "code": "SCHEMA_VALIDATION_FAILED",
  "errors": [
    { "path": "customer.address.city", "message": "Required field is missing" },
    { "path": "contacts[0].email", "message": "Must be a valid email address" }
  ]
}
```

### Reserved Field Rejection

```typescript
import { findReservedFieldConflicts } from '@basefyio/data-engine';

const conflicts = findReservedFieldConflicts(fields);
// Returns: ['_id', '_projectId'] if those names appear in user fields
```

### viewerState Write Rejection

```typescript
import { findViewerStateInDocument } from '@basefyio/data-engine';

const violations = findViewerStateInDocument(doc, fields);
// Returns paths where viewerState data was found in a document being written
// These paths must be rejected — viewerState is virtual, never stored
```

---

## 9. Query Layer

### Filter AST

All queries compile to a validated Filter AST:

```typescript
type Filter = FieldFilter | LogicalFilter | NotFilter;

interface FieldFilter {
  type: 'field';
  path: PathRef;         // { path: 'customer.address.city', isArrayPath: false }
  operator: FilterOperator;  // eq, neq, gt, gte, lt, lte, in, nin, contains, exists, regex, ...
  value: JsonValue;
}

interface LogicalFilter {
  type: 'and' | 'or';
  conditions: Filter[];
}
```

### EntityQuery (SQL-like mode target)

```typescript
interface EntityQuery {
  entity: string;
  select?: PathRef[];
  filter?: Filter;
  sort?: SortClause[];
  limit?: number;
  offset?: number;
  cursor?: string;
  includeSoftDeleted?: boolean;
}
```

### EntityAggregation (Aggregation DSL mode target)

```typescript
interface EntityAggregation {
  entity: string;
  pipeline: AggregationStage[];  // $match, $project, $unwind, $group, $sort, $limit, $skip
  cursor?: string;
}
```

**Allowed V1 stages:** `$match`, `$project`, `$unwind`, `$group`, `$sort`, `$limit`, `$skip`
**Allowed V1 accumulators:** `$count`, `$sum`, `$avg`, `$min`, `$max`
**Blocked V1:** `$lookup`, `$out`, `$merge`, `$function`, `$where`, `$accumulator`

### Nested Path Support

Filters can address nested fields:

```typescript
{ type: 'field', path: { path: 'customer.address.city', isArrayPath: false }, operator: 'eq', value: 'New York' }
{ type: 'field', path: { path: 'tags', isArrayPath: true }, operator: 'contains', value: 'urgent' }
```

The query compiler validates every path against the entity schema before producing a provider query.

---

## 10. REST API Reference

Base path: `/api/v1/projects/:projectId`

### Entity Management

| Method | Path | Description |
|--------|------|-------------|
| GET | `/entities` | List all entity definitions |
| POST | `/entities` | Create entity definition |
| GET | `/entities/:entity` | Get entity definition |

### Document CRUD

| Method | Path | Description |
|--------|------|-------------|
| POST | `/data/:entity` | Create record |
| GET | `/data/:entity` | List/query records |
| GET | `/data/:entity/:id` | Read record |
| PATCH | `/data/:entity/:id` | Partial update |
| PUT | `/data/:entity/:id` | Replace |
| DELETE | `/data/:entity/:id` | Soft delete |

### Query Parameters (GET /data/:entity)

| Param | Type | Example |
|-------|------|---------|
| `filter` | JSON string | `{"status":"active"}` |
| `sort` | JSON string | `[{"path":"_createdAt","direction":"desc"}]` |
| `limit` | number | `50` (max 1000) |
| `offset` | number | `0` |

### Health Check

| Method | Path | Description |
|--------|------|-------------|
| GET | `/data-engine/health` | Returns `{ available, reachable }` |

### Authentication

All endpoints require either:
- **JWT token** (Bearer header) — for Admin UI / dashboard access
- **API key** (apikey header) — for SDK / programmatic access

The same `JwtOrApiKeyGuard` used by the existing data endpoints.

---

## 11. SDK Usage

### Setup

```typescript
import { createClient } from 'basefyio-js';

const bf = createClient({
  projectId: 'prj_abc123',
  apiKey: 'your-anon-key',
});
```

### Entity Operations

```typescript
// List entities
const { data: entities } = await bf.data.listEntities();

// Create entity
await bf.data.createEntity({
  logicalName: 'patients',
  displayName: 'Patients',
  fields: [...],
});
```

### Document CRUD

```typescript
const patients = bf.data.collection<Patient>('patients');

// Insert
const { data: created } = await patients.insert({
  firstName: 'John',
  address: { city: 'New York', country: 'US' },
});

// Get by ID
const { data: doc } = await patients.get(created._id);

// Update (partial merge)
await patients.update(created._id, { firstName: 'Jane' });

// Replace (full)
await patients.replace(created._id, { firstName: 'Jane', address: { city: 'Boston', country: 'US' } });

// Delete (soft)
await patients.delete(created._id);
```

### Querying

```typescript
// Chainable query builder
const { data: page } = await bf.data.collection('patients')
  .find({ 'address.city': 'New York' })
  .sort('_createdAt', 'desc')
  .limit(20)
  .offset(40);

console.log(page.data);     // DataEngineDocument[]
console.log(page.total);    // total count
console.log(page.hasMore);  // boolean
```

### Projections

```typescript
// Fetch a mobile-ready projection
const { data: feed } = await bf.data.view<FeedCard>('mobileFeedCard', { limit: 20 });
```

### Health Check

```typescript
const { data: health } = await bf.data.health();
console.log(health.available);  // true if engine is configured
console.log(health.reachable);  // true if backing store responds
```

---

## 12. Event System & Outbox

### Write Path

```
REST API write → Validate → Write to NoSQL store → Insert DataEngineOutbox row (PostgreSQL)
```

### Outbox Table

```sql
-- data_engine_outbox
id            UUID PRIMARY KEY
type          VARCHAR(50)    -- document.created, document.updated, etc.
project_id    TEXT
entity        TEXT
document_id   TEXT
schema_version INT
payload       JSONB
status        VARCHAR(20)    -- PENDING, PROCESSED, FAILED
retry_count   INT
processed_at  TIMESTAMPTZ
created_at    TIMESTAMPTZ
```

### Event Types

| Type | Trigger |
|------|---------|
| `document.created` | New document inserted |
| `document.updated` | Document patched or replaced |
| `document.deleted` | Document soft-deleted |
| `entity.created` | New entity definition registered |
| `entity.schema.changed` | Entity schema version bumped |

### Subscribers

| Subscriber | Status | Purpose |
|-----------|--------|---------|
| `realtime` | Active | SSE broadcast to connected clients |
| `search` | Active | Re-index document in search |
| `audit` | Active | Write to AuditLog |
| `embedding` | Reserved | Vector embedding indexing |
| `workflow` | Reserved | Trigger workflow rules |
| `cdc` | Reserved | External change data capture |

---

## 13. Prisma Models

### DataPlaneProvisioning

Tracks the provisioning state machine per project.

```
PENDING → PROVISIONING → READY
                       → FAILED → PROVISIONING (retry)
READY → DELETING → DELETED
```

### EntityDefinition

The entity registry — stores field definitions, AI provenance, storage strategy.

Key fields: `logicalName`, `displayName`, `physicalCollection`, `storageStrategy`, `schemaVersion`, `fields` (JSON), `rules` (JSON), `generatedByAI`, `aiPrompt`, `aiReasoning`, `confidenceScore`, `sourceWorkbook`, `sourceSheet`.

### EntitySchemaVersion

Versioned JSON Schema snapshots. `snapshot` is the complete compiled schema at that version — never rely on replaying migrations to reconstruct state.

### ApplicationModel

Skeletal root aggregate. Future: owns entities, fields, forms, workflows, navigation, dashboards.

### DataEngineOutbox

Transactional outbox for event delivery.

### SavedDataQuery

Saved SQL-like and Aggregation queries per project.

### EntityNameMapping

Logical → physical name mapping. Renames never touch physical storage.

---

## 14. NestJS Integration

### DataEngineModule

```typescript
@Global()
@Module({
  providers: [DataEngineService],
  controllers: [DataEngineController],
  exports: [DataEngineService],
})
export class DataEngineModule {}
```

Registered in `app.module.ts`. The service auto-initializes on startup from env vars.

### DataEngineService

Injectable service wrapping the `@basefyio/data-engine` package:

```typescript
// Check availability
if (dataEngineService.isAvailable()) { ... }

// Get entity collection
const col = await dataEngineService.getEntityCollection(projectId, 'patients');

// Provisioning
await dataEngineService.provisionTenant(projectId);
await dataEngineService.deprovisionTenant(projectId);

// Health
const ok = await dataEngineService.ping();
```

### DataEngineController

Handles REST API at `/v1/projects/:projectId/...`. Uses `JwtOrApiKeyGuard` and `AuditLogInterceptor`.

---

## 15. Provisioning Lifecycle

### On Project Create

```
1. Existing flow: CREATE DATABASE, CREATE USER, RLS bootstrap, Keycloak realm
2. NEW: Insert DataPlaneProvisioning record (status: PENDING)
3. NEW: Enqueue 'data-engine-provision' BullMQ job
4. Return project immediately (data plane provisioning is async)
```

### Queue Worker

```
1. Update status: PROVISIONING
2. Call dataEngine.provisionTenant(projectId)
3. On success: Update status: READY
4. On failure: Update status: FAILED, increment retryCount
5. BullMQ retries: 1m → 5m → 15m → 1h
```

### On Project Delete

```
1. Existing flow: soft-delete project (rename, archive)
2. NEW: Call dataEngine.deprovisionTenant(projectId)
3. Documents soft-deleted (recoverable within retention window)
4. On permanent delete (24h cron): hard-delete documents
```

### Key Principle: Non-Blocking

The NoSQL store being down during project creation does NOT fail the create. The project works for SQL, auth, storage immediately. Data Engine becomes available once provisioning succeeds.

---

## 16. Docker Setup

### docker-compose.yml

The `nosql` service is added to the infrastructure section:

```yaml
nosql:
  image: couchbase/server:community-7.6.4
  ports:
    - "8091:8091"    # Management console
    - "8093:8093"    # N1QL query service
    - "11210:11210"  # KV data service
  volumes:
    - nosql_data:/opt/couchbase/var
  healthcheck:
    test: ["CMD-SHELL", "curl -sf http://localhost:8091/pools || exit 1"]
    interval: 10s
    timeout: 5s
    retries: 20
    start_period: 30s
```

### First-Time Setup

After `docker compose up`:

1. Open the management console at `http://localhost:8091`
2. Initialize the cluster (set admin credentials)
3. Create the `basefyio-apps` bucket
4. Create the `projects` scope within the bucket
5. Create the `records` collection within the scope

Or automate via the management REST API / CLI.

### Development Without NoSQL Store

Set `DATA_ENGINE_PROVIDER=postgres` — the PostgreSQL provider uses your existing project databases. No NoSQL store container needed.

---

## 17. Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_ENGINE_PROVIDER` | `disabled` | Provider: `nosql`, `postgres`, or `disabled` |
| `NOSQL_CONNSTR` | — | Connection string (e.g. `couchbase://nosql`) |
| `NOSQL_USERNAME` | `basefyio` | Store admin username |
| `NOSQL_PASSWORD` | `basefyio_secret` | Store admin password |
| `DATA_ENGINE_CONTAINER` | `basefyio-apps` | Top-level container/bucket name |
| `DATA_ENGINE_NAMESPACE` | `projects` | Default namespace/scope |
| `DATA_ENGINE_MAX_DOC_KB` | `1024` | Maximum document size (KB) |
| `DATA_ENGINE_MAX_NESTING_DEPTH` | `8` | Maximum schema nesting depth |
| `DATA_ENGINE_MAX_ARRAY_ITEMS` | `1000` | Maximum array items per field |

---

## 18. Testing

### Unit Tests (27 tests, always run)

```bash
cd packages/data-engine
npm test
```

Tests cover:
- JSON Schema compiler (flat fields, nested objects, arrays, counters, media, viewerState)
- Deterministic compilation (same input → same output)
- Reserved field conflict detection
- viewerState write rejection
- Name sanitization (spaces, hyphens, accents, numbers, truncation)
- TikTok fixture type-check (regression guard)

### Provider Contract Tests (run against live provider)

```bash
# Against PostgreSQL (requires running PostgreSQL)
DATA_ENGINE_PROVIDER=postgres npm run test:integration

# Against NoSQL store (requires running cluster)
DATA_ENGINE_PROVIDER=nosql npm run test:integration
```

The shared contract suite (`provider-contract.test.ts`) tests:
- Flat CRUD (insert, get, update, replace, soft-delete)
- Nested object CRUD
- Array of objects CRUD
- Nested path filtering
- Array path filtering (contains operator)
- Mandatory `_projectId` injection (cross-project isolation)
- CAS concurrency conflict
- Soft delete exclusion/inclusion
- Index creation (idempotent)
- Pagination (limit, offset, no overlap)
- Sorting (asc, desc)

### TikTok Fixture (CI regression guard)

`src/__fixtures__/tiktok-model.ts` encodes a full TikTok-like app model:
- 7 entity definitions (users, videos, comments, reactions, follows, notifications, moderation)
- Nested schemas (media, authorSnapshot, stats, moderation, music, previewReplies)
- Counter fields (views, likes, comments, shares)
- Virtual viewerState
- Projection (mobileFeedCard with relation includes)
- Mobile screen models (feed, profile)
- AI structure decisions with provenance
- Sample queries and aggregations

This fixture MUST type-check against all contracts. It is compiled in CI — if the type system can't represent a TikTok-like app, the build fails.

---

## 19. Vendor Neutrality Rules

These rules are enforced by code review and CI:

1. **The vendor name** of the chosen NoSQL store appears ONLY in `packages/data-engine/providers/nosql/`. Nowhere else — not in interfaces, module names, env vars, API routes, UI strings, docs headings, error messages, or commit messages.

2. **No code outside** `packages/data-engine` may import the store's SDK or touch provider-specific objects.

3. **Callers branch on `capabilities()`**, never on provider name. `if (provider === 'nosql')` outside the provider directory is a CI failure.

4. **User-facing naming** is "Basefyio Data Engine" or "NoSQL store" — never the vendor name.

5. **Env vars** use generic names: `NOSQL_CONNSTR`, `NOSQL_USERNAME`, `NOSQL_PASSWORD`.

6. **Forbidden phrases** (outside test fixtures): *native query, native aggregation, provider aggregation, raw aggregation, NoSQL-native*.

---

## 20. Runbook

### NoSQL Store Node Failure

**Symptoms:** Data Engine health check returns `{ available: true, reachable: false }`. API returns 503 on `/data/*` endpoints.

**Impact:** Only the data plane is affected. Auth, billing, SQL, storage, and all other features continue working.

**Resolution:**
1. Check container health: `docker compose ps nosql`
2. Check store logs: `docker compose logs nosql --tail=100`
3. If the container is down, restart: `docker compose restart nosql`
4. If the cluster needs rebalancing, access the management console at `:8091`
5. Verify recovery: `curl http://localhost:8091/pools`

### Provisioning Stuck in FAILED

**Symptoms:** `DataPlaneProvisioning` records with `status = FAILED` and `retryCount >= 4`.

**Resolution:**
1. Check `lastError` field for the failure reason
2. Fix the underlying issue (store connectivity, bucket not created, etc.)
3. Reset retry: `UPDATE data_plane_provisioning SET status = 'PENDING', retry_count = 0 WHERE project_id = '...'`
4. The queue worker will pick it up on next poll

### Document Write Latency Spike

**Symptoms:** P99 write latency exceeds 200ms.

**Resolution:**
1. Check store's built-in metrics dashboard
2. Verify indexes exist for frequently queried fields
3. Consider promoting high-volume entities from `shared-records` to `collection` strategy
4. Check document sizes — large documents (>100KB) slow writes

### Migration to New Provider

1. Implement the new provider in `packages/data-engine/providers/<name>/`
2. Run the contract test suite against it
3. Deploy with `DATA_ENGINE_PROVIDER=<name>`
4. Migrate existing documents via a batch job (read from old, write to new)
5. Switch the env var once migration is verified
