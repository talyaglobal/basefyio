# Architecture: NoSQL (CouchBase) Support

> Status: **Proposal** | Date: 2026-06-01

## Motivation

Basefyio currently supports only PostgreSQL. User feedback indicates that SQL-only databases cover roughly one-third of use cases. Many applications need a document/NoSQL store for:

- Flexible schemas (CMS content, user preferences, IoT telemetry)
- Key-value access patterns (sessions, caches, feature flags)
- Semi-structured data (logs, events, nested JSON documents)

**Why CouchBase?** CouchBase uniquely bridges SQL and NoSQL — its N1QL query language uses SQL-like syntax, lowering the learning curve for developers already using PostgreSQL through Basefyio. It also offers built-in full-text search, key-value sub-millisecond reads, and eventing.

---

## Data Model Mapping

| CouchBase Concept | Basefyio Equivalent | PostgreSQL Analogy |
|---|---|---|
| Cluster | Infrastructure | Server |
| Bucket | Project-scoped container | Database |
| Scope | Namespace | Schema |
| Collection | User-created collection | Table |
| Document | JSON document with key | Row |

---

## Architecture Layers

### Layer 1: Infrastructure Provisioning

Extend `InfrastructureService` (`apps/platform-api/src/modules/docker/`) to provision CouchBase containers:

```
Docker Image: couchbase/server:community-7.6.x
Ports: 8091 (management), 8093 (N1QL), 11210 (KV)
Memory: 512MB minimum (configurable per plan)
Storage: Docker volume per project
```

**Schema extension (Prisma):**
```prisma
model ProjectInfrastructure {
  // ... existing PG fields ...
  cbEnabled         Boolean  @default(false)
  cbContainerName   String?
  cbContainerHost   String?
  cbPortMgmt        Int?     // 8091
  cbPortN1ql        Int?     // 8093
  cbAdminUser       String?
  cbAdminPassword   String?
  cbMemoryMb        Int      @default(512)
  cbVolumeId        String?
}
```

**Provisioning flow:**
1. User enables NoSQL from project settings (or during project creation for qualifying plans)
2. Pull CouchBase image, create container on Docker network
3. Wait for health check, initialize cluster via CouchBase REST management API
4. Create a default bucket named `basefyio-{project-slug}`
5. Store connection details in ProjectInfrastructure

---

### Layer 2: Platform API — New Module

```
apps/platform-api/src/modules/couchbase/
  couchbase.module.ts
  couchbase.service.ts      — Connection management, N1QL execution, KV ops
  couchbase-rest.controller.ts — Public REST API for document operations
```

**REST API endpoints:**

```
GET    /api/rest/v1/doc/:collection              — List documents (N1QL WHERE filters)
GET    /api/rest/v1/doc/:collection/:id           — Get document by key
POST   /api/rest/v1/doc/:collection               — Insert document
PUT    /api/rest/v1/doc/:collection/:id            — Replace document
PATCH  /api/rest/v1/doc/:collection/:id            — Sub-document partial update
DELETE /api/rest/v1/doc/:collection/:id            — Delete document
POST   /api/rest/v1/doc/_query                     — Raw N1QL query
```

The `/doc/` prefix separates document endpoints from relational `/rest/v1/:table` endpoints. Auth uses the same `JwtOrApiKeyGuard`.

**Filter syntax (matching PostgreSQL REST API):**
```
?field=eq.value
?field=gt.10
?field=ilike.*search*
?order=field.desc&limit=20
```

---

### Layer 3: Admin UI

**New sidebar item:**
```typescript
{ label: 'Documents', href: '/documents', icon: FileJson }
```

**Pages:**
- `/documents` — Collection list + document browser
- `/documents/[collection]` — Document detail/editor with JSON syntax highlighting

**UI components:**
- Collection list sidebar (same pattern as table-editor)
- Document list with expandable JSON preview
- Full JSON editor for document create/edit
- Create collection dialog
- Import/export (JSON/CSV)

**N1QL integration:**
Extend the SQL Editor page with a mode toggle: "PostgreSQL | N1QL". Reuse the same editor component, route execution to CouchBase service.

---

### Layer 4: SDK Extension (basefyio-js)

```typescript
const bf = createClient({ apiUrl, projectId, apiKey });

// Existing relational API (unchanged)
bf.from('users').select('*').eq('id', 5);

// New document API
bf.doc('sessions').get('session_abc123');
bf.doc('sessions').insert({ userId: '...', data: { ... } });
bf.doc('sessions').list().eq('userId', 'abc').limit(10);
bf.doc('sessions').remove('session_abc123');

// Raw N1QL query
bf.n1ql('SELECT * FROM sessions WHERE userId = $1', ['abc']);
```

---

### Layer 5: Cross-Store Communication (Future)

- PostgreSQL `LISTEN/NOTIFY` → webhook → CouchBase eventing
- CouchBase change streams → platform-api → PostgreSQL sync
- Admin UI "Sync Rules" page for declarative cross-store mapping

---

## Implementation Phases

| Phase | Scope | Estimate |
|---|---|---|
| **Phase 1: Foundation** | Prisma schema, Docker provisioning, health check, enable/disable toggle in Settings | Small |
| **Phase 2: Core** | CouchBase module, document CRUD REST API, admin UI document browser, connection page section | Medium |
| **Phase 3: Query** | N1QL editor integration, SDK `.doc()` methods, full-text search UI | Medium |
| **Phase 4: Scale** | Multi-node clusters, backup/restore (`cbbackupmgr`), monitoring dashboard | Large |

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Memory cost** — CouchBase needs 512MB+ per instance | Shared CouchBase cluster for free-tier; dedicated instances for paid plans |
| **No native RLS** — CouchBase lacks PostgreSQL-style row-level security | Enforce access control at the API layer; scope documents by project |
| **License** — CouchBase Community Edition lacks XDCR and Analytics | Start with Community; evaluate Enterprise license for advanced features |
| **Backup complexity** — Different tool than pg_dump | Integrate `cbbackupmgr` alongside existing backup infrastructure |
| **Learning curve** — Users must understand two data paradigms | Context help panel explains when to use SQL vs NoSQL on each page |

---

## When to Use What

| Use Case | Recommended Store |
|---|---|
| Structured data with relations (users, orders, products) | PostgreSQL |
| Authentication and RLS-protected data | PostgreSQL |
| Flexible-schema content (CMS, blog posts, configurations) | CouchBase |
| Session store, cache, feature flags | CouchBase (KV) |
| Full-text search | CouchBase (FTS) |
| Time-series / IoT events | CouchBase |
| Complex joins and transactions | PostgreSQL |

---

## Open Questions

1. Should free-tier projects get a shared CouchBase cluster or no NoSQL at all?
2. How to handle cross-store foreign keys (e.g. PostgreSQL user ID in CouchBase documents)?
3. Should the N1QL editor share the same tab as SQL Editor or be a separate nav item?
4. Naming: expose as "CouchBase" or rebrand as "Basefyio Documents" / "BasefyioDB"?
