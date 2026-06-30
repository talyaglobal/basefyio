# Architecture

## Overview

basefyio is a multi-tenant backend platform. The core primitive is the **project**: an isolated unit that contains its own PostgreSQL database, authentication realm, storage namespace, and API context.

## Components

### Platform API (`apps/platform-api`)

NestJS application — the central runtime. All client and dashboard interactions go through here.

**Core modules:**

| Module | Path | Responsibility |
|---|---|---|
| `projects` | `src/modules/projects` | Project CRUD, listing, archiving |
| `provisioning` | `src/modules/provisioning` | DB + auth realm provisioning |
| `auth` | `src/modules/auth` | JWT validation, API key management |
| `sql` | `src/modules/sql` | Safe SQL execution engine |
| `data-engine` | `src/modules/data-engine` | Structured data layer |
| `data-query` | `src/modules/data-query` | Type-safe query builder |
| `data-structures` | `src/modules/data-structures` | Schema definitions |
| `storage` | `src/modules/storage` | Object storage (MinIO) |
| `realtime` | `src/modules/realtime` | SSE live subscriptions |
| `realtime-data` | `src/modules/realtime-data` | Data change streams |
| `queue` | `src/modules/queue` | BullMQ background jobs |
| `redis` | `src/modules/redis` | Redis client module |
| `agent` | `src/modules/agent` | AI agent scaffolding |
| `rag` | `src/modules/rag` | RAG pipeline |
| `embedding` | `src/modules/embedding` | Vector embedding management |
| `search` | `src/modules/search` | Full-text + semantic search |
| `pgbouncer` | `src/modules/pgbouncer` | Connection pool management |
| `observability` | `src/modules/observability` | Structured logs + trace IDs |
| `health` | `src/modules/health` | Readiness + liveness probes |
| `email` | `src/modules/email` | Transactional email (pluggable) |
| `teams` | `src/modules/teams` | Team membership |

### Admin UI (`apps/admin-ui`)

Next.js 14 dashboard. Communicates with the Platform API over REST + JWT. Features: project list, SQL editor, storage browser, audit log viewer.

### Auth Provider (Keycloak)

Each project gets a dedicated **Keycloak realm**. The Platform API provisions realms on project creation and validates JWTs using OIDC discovery.

The auth interface is designed to be provider-agnostic — Keycloak is the default but can be replaced by any OIDC-compliant provider.

### Database Layer

- **Platform DB** — PostgreSQL instance for platform metadata (projects, API keys, audit logs)
- **Project DBs** — One dedicated PostgreSQL database per project, provisioned at creation time
- **pgvector** — Vector extension enabled on all databases for AI workloads
- **PgBouncer** — Connection pooler in front of all project databases

### Queue

BullMQ on Redis. Used for:
- Background provisioning jobs
- Email delivery
- Scheduled tasks
- Agent execution

### Storage

MinIO object storage with per-project bucket namespacing. The storage module wraps MinIO with project-scoped credentials.

## Multi-Tenancy Model

```
Platform
└── Project A
    ├── PostgreSQL database: db_project_a
    ├── Keycloak realm: project-a
    └── MinIO bucket: project-a/

└── Project B
    ├── PostgreSQL database: db_project_b
    ├── Keycloak realm: project-b
    └── MinIO bucket: project-b/
```

Projects are fully isolated at the infrastructure level. There is no shared schema between projects.

## Request Flow

```
Client Request
  → Platform API
    → JWT validation (Keycloak OIDC)
    → Guard chain (module-enabled, rate-limit, audit-log)
    → Controller
    → Service (resolves project context)
    → Project database (via project-specific connection)
    → Response
```

## Data Engine

The Data Engine is an optional structured data layer on top of raw PostgreSQL. When enabled, it provides:

- Document-oriented storage within a relational database
- Type-safe schema definitions
- Query builder with filtering, sorting, and pagination
- Support for a CouchDB-compatible backend (opt-in via `--profile couchdb`)

## AI Stack

The platform includes first-class support for AI workloads:

- **pgvector** — vector storage and similarity search on every project database
- **Embedding module** — manages embedding generation and storage
- **RAG pipeline** — chunking, embedding, retrieval, and generation
- **Agent scaffolding** — tool adapter pattern for AI agent workflows
