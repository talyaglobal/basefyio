# Basefyio Data Engine — Phase 0: Reconnaissance & Design Review

> Status: **PHASE 0 — AWAITING APPROVAL** | Date: 2026-06-09
> Author: Platform Engineering
> Prompt source: Customer enterprise architecture specification

---

## 0. Executive Summary

This document is the mandatory Phase 0 gate before any code is written. It covers all 9 deliverables required by the specification, maps the customer's architecture against our existing codebase, and identifies what we already have, what needs to change, and what is new.

### What Already Exists (assets to keep/evolve)

| Asset | Location | Disposition |
|-------|----------|-------------|
| PostgreSQL JSONB collections | `projects/collection.service.ts` | **Replace** with Data Engine PostgresProvider |
| NoSQL filter translator | `projects/nosql-filter.util.ts` | **Absorb** into Data Engine query compiler |
| Collection admin API | `projects/collection.controller.ts` | **Replace** with `/v1/projects/:id/data/:entity` |
| Collection public API + RLS | `projects/public-collection-api.*` | **Replace** with Data Engine + RLS integration |
| SDK CollectionClient | `sdk/src/modules/collection.ts` | **Evolve** into `db.collection()` + `db.view()` |
| Admin UI Collections page | `admin-ui/components/collections-editor.tsx` | **Evolve** into Data tab with schema designer |
| Architecture proposal | `md/ARCHITECTURE-NOSQL-COUCHBASE.md` | **Superseded** by this document |

### What Is New

- `packages/data-engine` — provider-agnostic abstraction package
- NoSQL store provider (vendor-neutral; selected store per Section 4 below)
- PostgreSQL JSONB provider (dev-mode fallback, same interface)
- Prisma metadata models (EntityDefinition, EntityField, EntitySchemaVersion, etc.)
- Transactional outbox + event bus
- Provisioning state machine (PENDING → PROVISIONING → READY | FAILED)
- Validation pipeline (JSON Schema → field rules → cross-field rules → hooks)
- Two-mode query layer (SQL-like + Aggregation DSL)
- Projection/view layer for mobile-ready read models
- Docker infrastructure for the NoSQL store

### Gap Analysis: Existing Collections vs Data Engine

| Feature | Existing Collections | Data Engine (target) |
|---------|---------------------|---------------------|
| Storage | PostgreSQL JSONB per project DB | Dedicated NoSQL store (+ PG fallback) |
| Tenancy | Separate `nosql` schema per project DB | Shared container, `_projectId` discriminator |
| Schema | Schema-less | Versioned EntityField → JSON Schema |
| Validation | None | Full pipeline (JSON Schema → rules → hooks) |
| Envelope | `{id, data, created_at, updated_at}` | Full envelope with `_version`, `_entity`, `_status`, `_eventSequence`, etc. |
| Concurrency | Last-write-wins | Optimistic CAS via `_version` + If-Match |
| Events | Activity log only | Transactional outbox → subscriber bus |
| Nesting | Flat JSONB (nested paths in filter) | First-class nested schema with depth limits |
| Mobile | None | Projections, counters, viewerState, syncState |
| Query | MongoDB-like filter only | SQL-like + Aggregation DSL, both validated |
| Index | Manual GIN + field indexes | Schema-driven, auto-recommended |

---

## 1. Codebase Reconnaissance

### 1.1 Project Lifecycle Events

**Creation** (`projects.service.ts:create`, lines 95-251):
1. Validate name + assert team membership + check quota
2. Generate random `kb_<16hex>` DB name + `kb_user_<16hex>` user
3. Health-check Keycloak
4. CREATE DATABASE + CREATE USER + GRANT privileges
5. Apply RLS bootstrap SQL (roles: anon/authenticated/service_role + sentinel check)
6. Create Keycloak realm + clients → get anonKey/serviceKey
7. Insert Project record in Prisma
8. Side effects: activity log, realtime broadcast, usage increment, PgBouncer regen

**Data Engine hook point:** After step 7 (Prisma record created), before side effects. The `provisionTenant` call should be enqueued via BullMQ, not blocking the create response. Project status field or a new `DataPlaneProvisioning` model tracks state.

**Deletion** (`projects.service.ts:remove`, lines 584-692):
- 3-phase soft delete: rename+archive → update Prisma status=DELETED → side effects
- 24h retention window, hourly cron purges past retention
- Restore possible within retention window

**Data Engine hook point:** On soft delete, enqueue `deprovisionTenant` (soft-delete documents with scheduled purge). On permanent delete (cron), hard-delete from NoSQL store.

### 1.2 Membership Checks

Pattern: `assertTeamMember(teamId, userId)` — lookup `TeamMember` by composite key `(teamId, userId)`. Used in every project operation.

The Data Engine controller MUST reuse this exact pattern. The `/v1/projects/:projectId/data/*` routes need:
1. `@UseGuards(JwtOrApiKeyGuard)` (matches `project-data.controller.ts`)
2. Load Project → assert team membership (or API key validation)
3. Inject `_projectId` server-side

### 1.3 Auth Guards

| Guard | Usage | Data Engine usage |
|-------|-------|-------------------|
| `JwtAuthGuard` | Admin endpoints | Schema management, entity CRUD via dashboard |
| `JwtOrApiKeyGuard` | Data endpoints | Document CRUD (dashboard or API key) |
| `ApiKeyGuard` | Public SDK endpoints | SDK document operations |
| `AuditLogInterceptor` | All data mutations | Document writes, schema changes |

### 1.4 Rate Limiting

Existing: `RateLimitGuard` + `FrozenAccountGuard` in some controllers. The Data Engine should use the same guards plus per-project document-write rate limiting via Redis (`de:rate:{projectId}:{minute}`).

### 1.5 Health Checks

Main health at `main.ts` startup. The Data Engine should contribute a `/health` endpoint checking NoSQL store reachability (ping container + query service).

---

## 2. Provisioning Flow Analysis

### Current: Per-Project PostgreSQL + Keycloak

```
User creates project
  → Validate + quota check
  → CREATE DATABASE (PostgreSQL)
  → CREATE USER + GRANT
  → RLS bootstrap (anon/authenticated/service_role roles)
  → Create Keycloak realm + clients
  → Insert Project record (Prisma)
  → Activity log + realtime broadcast
```

### Target: Data Engine Added

```
User creates project
  → [existing PostgreSQL + Keycloak flow unchanged]
  → Insert Project record (Prisma)
  → Insert DataPlaneProvisioning record (status: PENDING)
  → Enqueue 'data-engine-provision' job (BullMQ)
  → Return project (data plane provisioning is async)

Queue worker picks up job:
  → Update status: PROVISIONING
  → Call dataEngine.provisionTenant(projectId, tier)
    → For NoSQL provider: ensure basefyio-apps container exists,
      ensure 'projects' namespace exists, create _projectId index
    → For PG provider: ensure nosql schema + records table in project DB
  → Update status: READY
  → Log activity: DATA_PLANE_PROVISIONED

On failure:
  → Update status: FAILED, increment retryCount
  → BullMQ retries with backoff: 1m → 5m → 15m → 1h
  → After max retries: alert + manual intervention
```

### Key Design Decision: Non-Blocking Provisioning

The NoSQL store being unreachable during project creation MUST NOT fail the create. The project is usable for SQL, auth, storage immediately. Data Engine becomes available once provisioning succeeds. The Admin UI shows a status badge ("Data Engine: provisioning..." / "ready" / "failed — retry").

---

## 3. Queue Integration Analysis

### Existing Queue Infrastructure

- **Framework:** BullMQ via `@nestjs/bullmq`, Redis-backed
- **Module:** `queue.module.ts` — `@Global()`, `BullModule.forRootAsync()` from Redis URL
- **Existing queues:** `import`, `email`, `export`, `billing`, `data-import`, `embedding`
- **Processor pattern:** `@Processor(QUEUE_NAME, { concurrency, lockDuration, stalledInterval, maxStalledCount })`
- **Worker events:** `@OnWorkerEvent('ready')`, `@OnWorkerEvent('error')`

### New Queues for Data Engine

| Queue | Purpose | Concurrency | Lock | Retry |
|-------|---------|-------------|------|-------|
| `data-engine-provision` | Tenant provisioning | 2 | 60s | 4 attempts: 1m→5m→15m→1h |
| `data-engine-deprovision` | Tenant teardown | 1 | 120s | 3 attempts: 5m→30m→2h |
| `data-engine-outbox` | Drain outbox events | 3 | 30s | Infinite (poll-based) |
| `data-engine-migration` | Lazy schema migrations | 2 | 300s | 3 attempts: 1m→5m→15m |

### Outbox Drainer Design

The outbox drainer is NOT a traditional BullMQ job-per-event. Instead:
- A recurring BullMQ job (every 5s) polls `DataEngineOutbox` for unprocessed events
- Batch-processes up to 100 events per poll
- Dispatches to registered subscribers
- Marks events as processed (or failed with retry count)

This avoids creating millions of individual BullMQ jobs for high-write workloads.

---

## 4. NoSQL Store Selection

### Requirements from Specification

| Requirement | Notes |
|-------------|-------|
| Document collections | Named collections within namespaces |
| Server-side parameterized queries | Must prevent injection |
| Secondary indexes | On nested paths + `_projectId` |
| CAS / optimistic concurrency | Document-level versioning |
| Namespace-level isolation | Scopes or equivalent for dedicated-tier tenants |
| SQL-like query language | For the SQL-like query mode |

### Selection: Couchbase Server

Per the existing architecture proposal (`md/ARCHITECTURE-NOSQL-COUCHBASE.md`), Couchbase is pre-selected. Justification against requirements:

| Requirement | Couchbase Capability |
|-------------|---------------------|
| Document collections | Scopes + Collections (native) |
| Parameterized queries | N1QL with `$1, $2` positional params |
| Secondary indexes | GSI indexes on any JSON path, including nested |
| CAS | Built-in CAS on every document operation |
| Namespace isolation | Scopes within a single bucket |
| SQL-like query | N1QL is SQL-compatible syntax |
| Full-text search | Built-in FTS service |
| Eventing | Built-in eventing service |
| K/V sub-ms reads | Native KV engine |

**Docker image:** `couchbase/server:community-7.6.x`
**SDK:** `couchbase` npm package (official Node.js SDK)
**Vendor neutrality:** The name "Couchbase" appears ONLY inside `packages/data-engine/providers/nosql/`. Everywhere else: "NoSQL store" or "Data Engine".

### Documented Limits (Couchbase 7.6)

| Resource | Limit |
|----------|-------|
| Buckets per cluster | 30 |
| Scopes per bucket | 1,200 |
| Collections per scope | 1,200 |
| Collections per bucket | 1,200 |
| Max document size | 20 MB |
| Max key length | 250 bytes |
| GSI indexes per bucket | Thousands (practical: ~200 for performance) |

These limits directly inform the tenancy model below.

---

## 5. Entity-Explosion Calculations & Tenancy Scaling

### Assumptions

| Parameter | Conservative | Moderate | Aggressive |
|-----------|-------------|----------|------------|
| Total projects | 1,000 | 10,000 | 50,000 |
| AI-generated entities per project | 10 | 50 | 200 |
| Total logical entities | 10,000 | 500,000 | 10,000,000 |
| Active entities (>100 docs) | 2,000 | 50,000 | 500,000 |
| Hot entities (>100k docs) | 50 | 500 | 2,000 |

### Option A: Shared Collections + `_projectId` Discriminator (RECOMMENDED)

**Physical layout:**
```
Bucket: basefyio-apps (1 bucket)
  Scope: projects (1 shared scope)
    Collection: records          ← shared-records strategy (DEFAULT)
    Collection: patients         ← promoted entities (high-volume)
    Collection: orders           ← promoted entities
    Collection: ...              ← up to ~1,200 promoted collections
```

**Resource consumption at 10k projects / 500k logical entities:**
- Buckets: 1 (of 30 limit) — 3%
- Scopes: 1 shared + ~50 dedicated-tier scopes = ~51 (of 1,200 limit) — 4%
- Collections: 1 `records` + ~500 promoted = ~501 (of 1,200 limit) — 42%
- Indexes: ~500 promoted × 2 avg + shared indexes = ~1,050

**At 50k projects / 10M logical entities:**
- Collections: 1 `records` + ~2,000 promoted → EXCEEDS 1,200 limit

**Mitigation:** At extreme scale, shard across multiple scopes (e.g., `projects_a` through `projects_z` by entity name hash). This is a future operational concern, not a day-one design change.

### Option B: Scope Per Project (REJECTED)

**Physical layout:**
```
Bucket: basefyio-apps
  Scope: prj_abc123 (1 per project)
    Collection: patients
    Collection: orders
    ...
```

**At 10k projects:**
- Scopes: 10,000 → EXCEEDS 1,200 limit immediately

**Verdict:** Option B is not viable at scale. Rejected.

### Option C: Hybrid (SELECTED)

Default: Option A (shared scope, `_projectId` discriminator).
Enterprise upsell: `dedicated-scope` tier gets its own scope (`prj_<id>`) within the same bucket.

**Dedicated-scope tenants are capped** at a reasonable limit (e.g., 100 enterprise tenants) because scopes are a finite cluster resource.

---

## 6. `collection` vs `shared-records` Promotion Thresholds

### Default: `shared-records`

Every new entity starts in the generic `records` collection, discriminated by `_entity` + `_projectId`. This is critical because:

- 10k projects × 100 entities = 1M logical entities
- 99% of entities are long-tail (<1,000 documents)
- Creating a collection per entity would exhaust the 1,200 limit instantly

### Promotion Criteria (Entity → Dedicated Collection)

An entity is promoted to a dedicated collection when ANY of:

| Criterion | Threshold | Rationale |
|-----------|-----------|-----------|
| Document count | > 100,000 | GC and compaction work better with isolated data |
| Write rate | > 50 writes/sec sustained | Reduces contention on shared collection |
| Unique query patterns | > 3 entity-specific indexes needed | Indexes on shared collection serve all entities; dedicated indexes are more efficient |
| Read latency P99 | > 50ms on filtered queries | Dedicated collection allows better index coverage |
| Manual override | Admin/API flag | Enterprise customers can request promotion |

### Promotion Process

1. Metadata update: set `storageStrategy = 'collection'` in `EntityDefinition`
2. Create new collection in NoSQL store
3. Background migration: copy documents from `records` (filtered by `_entity` + `_projectId`) to dedicated collection
4. Atomic metadata flip: update `physicalCollection` mapping
5. Delete migrated documents from `records` (after verification)

This is an **online, metadata-driven move** — zero downtime, callers never know.

### Demotion

If a promoted entity's volume drops (e.g., project scaled down), it can be demoted back to `shared-records` via the reverse process. This is manual/admin-only.

---

## 7. Outbox Architecture

### Write Path

```
┌─────────────────────────────────────────────────────┐
│  REST API: POST /v1/projects/:id/data/:entity       │
│  1. Validate schema (EntityField → JSON Schema)      │
│  2. Run validation pipeline                          │
│  3. Write document to NoSQL store (get CAS back)     │
│  4. Write DataEngineOutbox row in PostgreSQL          │
│     { id, type, projectId, entity, documentId,       │
│       schemaVersion, payload, status: PENDING }       │
│  5. Return response to client                        │
└─────────────┬───────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────┐
│  Outbox Drainer (BullMQ recurring job, every 5s)     │
│  1. SELECT * FROM DataEngineOutbox                   │
│     WHERE status = 'PENDING'                         │
│     ORDER BY createdAt LIMIT 100                     │
│  2. For each event, dispatch to subscribers:          │
│     ┌─ realtime (SSE broadcast)                      │
│     ├─ search (re-index document)                    │
│     ├─ audit (write AuditLog)                        │
│     ├─ [reserved] embedding (vector index)           │
│     ├─ [reserved] workflow (trigger rules)            │
│     └─ [reserved] cdc (external replication)          │
│  3. Update status: PROCESSED (or FAILED + retryCount)│
└─────────────────────────────────────────────────────┘
```

### Subscriber Registration

```typescript
// data-engine-events.service.ts
const SUBSCRIBERS: EventSubscriber[] = [
  { name: 'realtime', handler: realtimeHandler, active: true },
  { name: 'search', handler: searchHandler, active: true },
  { name: 'audit', handler: auditHandler, active: true },
  { name: 'embedding', handler: null, active: false },  // reserved
  { name: 'workflow', handler: null, active: false },    // reserved
  { name: 'cdc', handler: null, active: false },         // reserved
];
```

Inactive subscribers are skipped. Activating one later is a config change, not a code change.

### Consistency Guarantees

- **Document write succeeds, outbox write fails:** Document is written but events are lost. Mitigation: wrap outbox INSERT in a try/catch; if it fails, enqueue a reconciliation job that scans for documents without matching outbox events.
- **Document write fails:** No outbox event is created. Clean.
- **Outbox drainer fails mid-batch:** Events remain PENDING; next poll picks them up. Idempotent.

---

## 8. ApplicationModel Integration Plan

### Current State

There is no `ApplicationModel` in the codebase. The nearest concepts are:
- `Project` — the top-level tenant container
- `ProjectAuthConfig` — per-project auth settings
- `ProjectActivityLog` — audit trail

### Phase 0 Plan: Skeletal Model

```prisma
model ApplicationModel {
  id          String   @id @default(uuid())
  projectId   String   @map("project_id")
  name        String
  description String?
  definition  Json     @default("{}")   // Full app model (future)
  version     Int      @default(1)
  createdBy   String?  @map("created_by")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  entities    EntityDefinition[]

  @@unique([projectId, name])
  @@map("application_models")
}
```

### Future Integration Path

```
ApplicationModel (root aggregate)
  ├── EntityDefinition[] (entity registry)
  │     ├── EntityField[] (field model)
  │     │     └── ValidationRule[] (field validations)
  │     ├── EntityRule[] (cross-field business rules)
  │     └── EntitySchemaVersion[] (versioned snapshots)
  ├── FormDefinition[] (form builder output)
  ├── WorkflowDefinition[] (approval/automation flows)
  ├── AppProjection[] (mobile-ready read models)
  ├── MobileScreenModel[] (screen definitions)
  ├── SavedDataQuery[] (saved SQL/Aggregation queries)
  └── NavigationDefinition (app navigation tree)
```

All of this lives in **PostgreSQL metadata only**. The NoSQL store holds only application records (user data). This separation is the core architectural principle.

### Integration Timeline

- **Phase 1:** Define skeletal `ApplicationModel` + `EntityDefinition` + `EntityField` + `EntitySchemaVersion` Prisma models
- **Phase 4:** Wire `EntityDefinition` as the entity registry for the Data Engine REST API
- **Phase 5:** Add `FormDefinition`, `WorkflowDefinition`, `AppProjection` (skeletal)
- **Future:** AI builder creates `ApplicationModel` from Excel/prompt → generates all sub-models

---

## 9. TikTok-Style Mobile Modeling Comparison

### Entity Set

| Entity | Storage Strategy | Key Fields |
|--------|-----------------|------------|
| `users` | `shared-records` initially, promote at scale | profile, avatar, bio, settings |
| `videos` | `collection` (high volume) | media, authorSnapshot, hashtags, stats, moderation |
| `comments` | `collection` (high volume) | videoId, authorSnapshot, text, previewReplies[] |
| `follows` | `collection` (high write) | followerId, followeeId |
| `reactions` | `shared-records` | videoId, userId, type |
| `notifications` | `shared-records` | userId, type, payload, read |
| `moderation_events` | `shared-records` | videoId, action, reason, moderatorId |

### Video Document (Document-Native)

```json
{
  "_id": "vid_abc123",
  "_entity": "videos",
  "_projectId": "prj_tiktok",
  "_schemaVersion": 1,
  "_version": 42,
  "_lastEventId": "evt_xyz",
  "_eventSequence": 42,
  "_status": "active",
  "_createdAt": "2026-06-09T10:00:00Z",
  "_updatedAt": "2026-06-09T15:30:00Z",
  "_createdBy": "user_creator1",
  "_deletedAt": null,

  "title": "Amazing sunset timelapse",
  "description": "Shot in Cappadocia",
  "media": {
    "url": "https://cdn.example.com/videos/abc123.mp4",
    "thumbnailUrl": "https://cdn.example.com/thumbs/abc123.jpg",
    "duration": 45,
    "width": 1080,
    "height": 1920,
    "aspectRatio": "9:16",
    "codec": "h264"
  },
  "authorSnapshot": {
    "userId": "user_creator1",
    "username": "naturelover",
    "displayName": "Nature Lover",
    "avatarUrl": "https://cdn.example.com/avatars/creator1.jpg",
    "verified": true
  },
  "hashtags": ["sunset", "cappadocia", "timelapse", "nature"],
  "stats": {
    "views": 0,
    "likes": 0,
    "comments": 0,
    "shares": 0,
    "saves": 0
  },
  "moderation": {
    "status": "approved",
    "reviewedAt": "2026-06-09T10:01:00Z",
    "flags": []
  },
  "music": {
    "trackId": "track_456",
    "title": "Peaceful Piano",
    "artist": "Ambient Studio"
  }
}
```

### mobileFeedCard Projection

```json
{
  "id": "mobileFeedCard",
  "projectId": "prj_tiktok",
  "name": "mobileFeedCard",
  "sourceEntity": "videos",
  "shape": {
    "_id": "string",
    "title": "string",
    "media": { "url": "string", "thumbnailUrl": "string", "duration": "number", "aspectRatio": "string" },
    "authorSnapshot": { "username": "string", "displayName": "string", "avatarUrl": "string", "verified": "boolean" },
    "hashtags": ["string"],
    "stats": { "views": "counter", "likes": "counter", "comments": "counter", "shares": "counter" },
    "music": { "title": "string", "artist": "string" },
    "viewerState": { "liked": "boolean", "saved": "boolean", "following": "boolean" }
  },
  "includes": [
    { "field": "viewerState.liked", "source": "reactions", "match": { "videoId": "$._id", "userId": "$viewer", "type": "like" }, "compute": "exists" },
    { "field": "viewerState.saved", "source": "reactions", "match": { "videoId": "$._id", "userId": "$viewer", "type": "save" }, "compute": "exists" },
    { "field": "viewerState.following", "source": "follows", "match": { "followerId": "$viewer", "followeeId": "$.authorSnapshot.userId" }, "compute": "exists" }
  ],
  "cachePolicy": "feed"
}
```

### Flat-SQL vs Document-Native Comparison

| Aspect | Flat SQL (PostgreSQL) | Document-Native (Data Engine) |
|--------|-----------------------|-------------------------------|
| **User profile** | 1 row in `users` table, avatar URL as text column | Nested `profile` object with `avatar`, `settings`, `preferences` — single read |
| **Video post** | `videos` table + JOIN `users` for author + JOIN `video_stats` for counts | Single document with embedded `authorSnapshot`, `media`, `stats` — zero joins |
| **Feed card** | SELECT v.*, u.username, u.avatar, COUNT(r.id) as likes, EXISTS(SELECT...) as viewer_liked FROM videos v JOIN users u ... LEFT JOIN reactions r ... — N+1 or complex CTE | `GET /views/mobileFeedCard` — projection resolves author, stats (counters), viewer state server-side, returns screen-ready JSON |
| **Comments** | `comments` table, self-join for replies, JOIN users for author per comment | Top-level `comments` entity with embedded `previewReplies[]` (first 3 replies embedded, rest via pagination) |
| **Likes/Views** | `UPDATE videos SET likes = likes + 1` or separate `reactions` table with COUNT | `counter` field incremented via outbox event stream — no full-document rewrite, no aggregate table |
| **Viewer state** | `EXISTS(SELECT 1 FROM reactions WHERE videoId=? AND userId=? AND type='like')` per video — N queries for feed | `viewerState` virtual field computed at projection time from relation data — batch-resolved |
| **Offline cache** | Custom sync logic, no built-in versioning | Envelope `_version` + `_eventSequence` → mobile SDK tracks last-seen sequence, requests delta |
| **UI generation** | Column types → form fields (flat) | Nested schema paths → collapsible sections, repeatable arrays, media components, counter badges |

### Conclusion

Basefyio does **not** copy TikTok's internal architecture. The comparison proves that a TikTok-like product is modeled naturally with:
- **Document records** (video with embedded author snapshot, media metadata, moderation state)
- **Nested schemas** (media object, author object, music object — all first-class in EntityField)
- **Counter fields** (views/likes/comments/shares — incremented via events, not document rewrites)
- **Projections** (mobileFeedCard resolves author + stats + per-user viewerState server-side)
- **Relations** (comments as separate entity with embedded preview replies — hybrid embed+relation)
- **Outbox events** (like/view/share events flow through the event bus to update counters and trigger notifications)
- **Sync metadata** (envelope `_version` + `_eventSequence` → offline-first mobile apps)

No custom backend code required. The AI builder defines entities + projections + screen models; the Data Engine handles storage, validation, events, and mobile-ready responses.

---

## 10. Compatibility Analysis: Customer Requirements vs Our System

### Fully Compatible (existing patterns reused)

- NestJS module structure → `DataEngineModule`
- Prisma migrations → new models alongside existing ones
- BullMQ queues → new processors for provisioning/outbox
- Keycloak auth → same JWT/API key guards
- Realtime events → same SSE infrastructure
- Redis caching → same `RedisService`
- Activity logging → same `ProjectActivityService` pattern
- Rate limiting → same guard pattern
- Docker Compose → add NoSQL store service

### Requires Adaptation

- **Project.status field**: Currently `ACTIVE | PAUSED | DELETED`. Data plane status needs a separate `DataPlaneProvisioning` model (not overloading Project status).
- **Existing collection code**: The 6 files we built (collection.service, controller, public API, SDK module, admin UI) will be **replaced** by the Data Engine, not evolved. They served as a prototype; the Data Engine is architecturally different (provider abstraction, metadata-driven schemas, envelope, events).
- **Admin UI Collections page**: Needs to be redesigned as a "Data" tab with entity list, schema designer, document browser, and query editor. The existing `collections-editor.tsx` is too simple for the target UX.

### Not Compatible (new infrastructure)

- NoSQL store cluster (Docker service)
- `packages/data-engine` (new package, new abstraction)
- Expression language for `EntityRule` (sandboxed evaluator — needs research)
- Aggregation DSL parser (new compiler)
- SQL-like query parser (new compiler)

---

## 11. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| NoSQL store unavailable during project create | Medium | Non-blocking provisioning; data plane is async |
| Shared collection performance at scale | High | `shared-records` + promotion thresholds; monitor P99 |
| Schema evolution complexity | Medium | Lazy migration; never block API on rewrite |
| Expression language security | High | No `eval`; purpose-built sandboxed evaluator |
| Vendor lock-in | Medium | Provider interface; PostgreSQL fallback proves abstraction |
| Scope/collection limits at extreme scale | Low (long-term) | Sharding strategy documented; not day-one concern |
| Existing collection code migration | Low | Clean replacement; no data migration needed (collections were empty/prototype) |

---

## 12. Recommended Implementation Order

Per the specification's phased plan, with our codebase-specific notes:

| Phase | Scope | Dependencies | Estimate |
|-------|-------|-------------|----------|
| **Phase 1** | Metadata contracts + interfaces (types only, no providers) | None | 2-3 days |
| **Phase 1b** | TikTok fixture hard gate (type-check against contracts) | Phase 1 | 1 day |
| **Phase 2** | Provider contract tests (test suite before providers) | Phase 1 | 1-2 days |
| **Phase 3** | NoSQL + PostgreSQL providers | Phase 2 | 3-4 days |
| **Phase 4** | Platform API + Prisma models + provisioning + REST + outbox | Phase 3 | 4-5 days |
| **Phase 5** | Admin UI (schema designer, data tab, query editor) + SDK | Phase 4 | 4-5 days |
| **Phase 6** | Hardening (load tests, failure modes, docs, runbook) | Phase 5 | 2-3 days |

**Total estimated: 17-23 working days**

---

## DECISION REQUIRED

This document covers all 9 Phase 0 deliverables. Before any code is written:

1. **Approve/reject** the NoSQL store selection (Couchbase)
2. **Approve/reject** the tenancy model (shared collections + `_projectId` discriminator, `shared-records` default)
3. **Approve/reject** the promotion thresholds (100k docs / 50 writes/sec / 3+ indexes / 50ms P99)
4. **Approve/reject** the outbox architecture (PostgreSQL outbox + BullMQ poll drainer)
5. **Approve/reject** replacing existing collection code vs evolving it
6. **Confirm** implementation order and priorities

**Awaiting approval to proceed to Phase 1.**
