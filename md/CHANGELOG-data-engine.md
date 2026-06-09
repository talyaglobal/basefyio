# Basefyio Data Engine — Changelog

## v0.1.0 — June 2026

### Introducing the Basefyio Data Engine

We're excited to announce the **Basefyio Data Engine** — a brand new document data plane that runs alongside your existing PostgreSQL databases. Build applications with flexible, schema-driven document storage while keeping all the relational power you already rely on.

---

### What's New

#### Document Data Plane

Every Basefyio project now has access to a dedicated **document data plane** for storing application records — user-generated content, form submissions, AI-generated data, CMS entries, IoT events, and more. Your existing PostgreSQL databases, SQL Editor, Table Editor, and all other features continue to work exactly as before.

- **Schema-driven documents** — Define entities with typed fields (text, number, date, email, boolean, nested objects, arrays, media, counters, and more). Documents are validated against your schema on every write.
- **Nested data is first-class** — Store complex structures naturally: objects inside objects, arrays of objects, repeatable sections. No flattening into SQL-style columns required.
- **Document versioning** — Every document carries a version number and event sequence. Optimistic concurrency (If-Match) prevents lost updates in multi-user scenarios.
- **Soft delete with recovery** — Deleted documents are recoverable within the retention window. No accidental data loss.

#### Entity Management

- **Create entities** from the Admin UI or API — give them a logical name, display name, and optional description
- **AI provenance** — Entities created by the AI builder carry metadata about why they exist: source workbook, sheet, confidence score, and reasoning
- **Versioned schemas** — Every schema change creates a new version snapshot. Documents store which version they were written under. Breaking changes trigger lazy migration — never blocking your API.

#### REST API

Full CRUD on your application data via a clean REST API:

```
POST   /v1/projects/:projectId/data/:entity          — Create record
GET    /v1/projects/:projectId/data/:entity          — List/query records
GET    /v1/projects/:projectId/data/:entity/:id      — Read record
PATCH  /v1/projects/:projectId/data/:entity/:id      — Partial update
PUT    /v1/projects/:projectId/data/:entity/:id      — Replace
DELETE /v1/projects/:projectId/data/:entity/:id      — Delete (soft)
```

All endpoints use the same authentication (JWT or API key) and authorization (team membership) as your existing Basefyio APIs. Rate limiting and document size limits are enforced server-side.

#### SDK Support

The Basefyio SDK now includes a `data` client with chainable queries:

```typescript
const bf = createClient({ projectId: '...', apiKey: '...' });

// Entity management
await bf.data.createEntity({
  logicalName: 'patients',
  displayName: 'Patients',
  fields: [
    { name: 'firstName', kind: 'scalar', type: 'text', required: true },
    { name: 'address', kind: 'object', children: [
      { name: 'city', kind: 'scalar', type: 'text' },
      { name: 'country', kind: 'scalar', type: 'text' },
    ]},
  ],
});

// Document CRUD
const { data: patient } = await bf.data.collection('patients').insert({
  firstName: 'John',
  address: { city: 'New York', country: 'US' },
});

// Chainable queries
const { data: results } = await bf.data.collection('patients')
  .find({ 'address.city': 'New York' })
  .sort('_createdAt', 'desc')
  .limit(20);

// Projections (mobile-ready read models)
const { data: feed } = await bf.data.view('mobileFeedCard');
```

#### Admin UI — Data Tab

A new **Data** tab in each project's sidebar gives you:

- **Entity sidebar** — Browse all entities, see which ones were AI-generated, search by name
- **Document browser** — View documents as expandable JSON cards with envelope metadata (version, status, timestamps)
- **JSON filter** — Filter documents with JSON syntax, e.g. `{"status": "active"}`
- **Insert/Edit/Delete** — Full CRUD with JSON editors
- **Pagination** — Server-side, 50 documents per page
- **Engine label** — A read-only "Basefyio Data Engine" badge in the sidebar (never the underlying store's name)

#### Two Storage Providers

The Data Engine supports two providers, selected by environment variable:

| Provider | Use Case | Set via |
|----------|----------|---------|
| **NoSQL store** | Production — optimized for document workloads | `DATA_ENGINE_PROVIDER=nosql` |
| **PostgreSQL** | Development — no extra infrastructure needed | `DATA_ENGINE_PROVIDER=postgres` |

Both providers implement the identical interface. Your application code, SDK calls, and Admin UI work the same regardless of which provider is active. Switch between them with a single environment variable.

#### Multi-Tenant Isolation

Every document is automatically tagged with your project's ID. The query engine injects this filter server-side — it cannot be omitted or overridden. A token for Project A can never read Project B's data.

Enterprise projects can request **dedicated-scope** isolation for physical separation within the store.

#### Event System

Every document write produces an event in the transactional outbox:

- `document.created` / `document.updated` / `document.deleted`
- `entity.created` / `entity.schema.changed`

Events are processed by subscribers: realtime notifications, search indexing, and audit logging. Additional subscribers (embeddings, workflows, CDC) are reserved for future activation — adding them will be a configuration change, not a code change.

#### Mobile-Ready Architecture

The schema system includes primitives designed for mobile application generation:

- **`media`** — URL + dimensions, duration, aspect ratio
- **`counter`** — Likes, views, shares — updated via events, not document rewrites
- **`viewerState`** — Per-user state (liked, saved, following) resolved at read time, never stored in documents
- **`syncState`** — Offline sync metadata paired with document versioning
- **`localizedText`** — Per-locale content

The **projection layer** (`GET /v1/projects/:id/views/:projection`) returns screen-ready JSON shapes — no client-side joins needed.

---

### What Didn't Change

Everything you already use continues to work exactly as before:

- PostgreSQL per-project databases
- Table Editor and SQL Editor
- Row-Level Security (RLS)
- Keycloak authentication
- Storage (MinIO)
- Billing and subscriptions
- Team management and permissions
- CLI commands
- Existing Collections API (still available, will be deprecated in a future release)
- SDK `bf.from()`, `bf.sql()`, `bf.collection()` methods

The Data Engine is **purely additive**. If you don't enable it (`DATA_ENGINE_PROVIDER=disabled`), your projects behave identically to before.

---

### Getting Started

**1. Enable the Data Engine** — Set `DATA_ENGINE_PROVIDER=postgres` (dev) or `DATA_ENGINE_PROVIDER=nosql` (production) in your environment.

**2. Create an entity** — Go to any project → Data tab → click (+) → define your entity.

**3. Insert documents** — Use the Admin UI, REST API, or SDK.

**4. Query** — Filter with JSON syntax in the UI, or use the SDK's chainable query builder.

For the production NoSQL store, add the `nosql` service to your Docker Compose and configure `NOSQL_CONNSTR`, `NOSQL_USERNAME`, `NOSQL_PASSWORD`.

---

### Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_ENGINE_PROVIDER` | `disabled` | `nosql`, `postgres`, or `disabled` |
| `NOSQL_CONNSTR` | — | NoSQL store connection string |
| `NOSQL_USERNAME` | `basefyio` | NoSQL store admin username |
| `NOSQL_PASSWORD` | `basefyio_secret` | NoSQL store admin password |
| `DATA_ENGINE_CONTAINER` | `basefyio-apps` | Top-level container name |
| `DATA_ENGINE_NAMESPACE` | `projects` | Default namespace |
| `DATA_ENGINE_MAX_DOC_KB` | `1024` | Max document size in KB |
| `DATA_ENGINE_MAX_NESTING_DEPTH` | `8` | Max nesting depth for schemas |
| `DATA_ENGINE_MAX_ARRAY_ITEMS` | `1000` | Max array items per field |

---

### What's Next

- **Query Editor** — Two-mode query interface (SQL-like + Aggregation DSL) in the Admin UI
- **Schema Designer** — Visual entity field editor with nested object/array support
- **Validation Pipeline** — Full execution of JSON Schema → field rules → cross-field rules → hooks
- **Lazy Schema Migration** — Background document upgrades on schema changes
- **Index Recommendations** — Automatic index suggestions based on query patterns
- **Workflow Engine** — Approval flows and automations triggered by document events
