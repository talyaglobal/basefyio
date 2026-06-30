# Architecture

## Overview

basefyio is a multi-tenant backend platform. The core primitive is the **project**: an isolated unit that contains its own PostgreSQL database, authentication realm, storage namespace, and API context.

## MYFYIO Ecosystem

basefyio is the **core backend platform** in the MYFYIO ecosystem. AI and product-specific capabilities live in separate products that build *on top of* basefyio — they are intentionally **not** part of the core.

| Product | Role |
|---|---|
| **basefyio** | Core backend platform (this repository) |
| **agentfyio** | AI runtime (agents, RAG, embeddings) |
| **codefyio** | Development environment |
| **deployfyio** | Deployment platform |
| **mcpfyio** | MCP platform |

### Governance Rules

**1. Core Acceptance Rule.** A module belongs in basefyio core only if it satisfies *all three*:
- it is useful without AI/LLMs,
- it is generally applicable to every basefyio deployment,
- it has no dependency on commercial or hosted services.

If any answer is "no", it belongs in another MYFYIO product or in `_deferred/`.

**2. Dependency Rule (one-way).** The dependency graph flows in a single direction:

```
MYFYIO
└── basefyio (core)
       ▲       ▲       ▲       ▲
       │       │       │       │
   agentfyio deployfyio codefyio mcpfyio
```

`agentfyio`, `deployfyio`, `codefyio`, and `mcpfyio` may depend on basefyio. **basefyio must never import from any of them.** This keeps the core reusable and independent.

**3. Stable Public API Rule.** The v0.1 public contract is: **REST API · CLI · SDK · configuration · Prisma schema.** Internal module refactors are fine, but these interfaces must not break unnecessarily once published.

### Deferred modules (`_deferred/`)

AI-specific capabilities are intentionally excluded from basefyio v0.1 and reserved for a future move into **agentfyio**. The top-level `_deferred/` directory is a **boundary marker / documentation area**, not a guarantee that the full module source lives here — some deferred code may remain only in the private source repository or in future MYFYIO repositories.

The deferred areas (destination **agentfyio**) are:

```
_deferred/
├── agent          # AI agent scaffolding
├── rag            # RAG pipeline
├── embedding      # vector embedding management
├── recommendation # recommendations
└── README.md      # why these are deferred + where they'll live
```

> Nothing in `apps/` or `packages/` may import from `_deferred/`. If deferred code is later added here, it must remain excluded from `tsconfig`, CI, package exports, and runtime imports.

## Components

### Platform API (`apps/platform-api`)

NestJS application — the central runtime. All client and dashboard interactions go through here.

**v0.1 core modules:**

| Module | Path | Responsibility |
|---|---|---|
| `auth` | `src/modules/auth` | JWT validation, API key management |
| `projects` | `src/modules/projects` | Project CRUD, listing, archiving |
| `provisioning` | `src/modules/provisioning` | DB + auth realm provisioning |
| `sql` | `src/modules/sql` | Safe SQL execution engine |
| `storage` | `src/modules/storage` | Object storage (MinIO) |
| `data-engine` | `src/modules/data-engine` | Structured data layer |
| `data-query` | `src/modules/data-query` | Type-safe query builder |
| `data-structures` | `src/modules/data-structures` | Schema definitions |
| `realtime` | `src/modules/realtime` | SSE live subscriptions |
| `realtime-data` | `src/modules/realtime-data` | Data change streams |
| `queue` | `src/modules/queue` | BullMQ background jobs |
| `redis` | `src/modules/redis` | Redis client module |
| `observability` | `src/modules/observability` | Structured logs + trace IDs |
| `health` | `src/modules/health` | Readiness + liveness probes |
| `infrastructure` | `src/modules/infrastructure` | Infrastructure orchestration |
| `pgbouncer` | `src/modules/pgbouncer` | Connection pool management |
| `teams` | `src/modules/teams` | Team membership |
| `email` | `src/modules/email` | Transactional email (pluggable) |

**Deferred (→ agentfyio, in `_deferred/`):** `agent`, `rag`, `embedding`, `recommendation`.

**Search is split along the AI/core line:**

| Stays in core | Deferred (→ agentfyio / datafyio) |
|---|---|
| SQL search | embeddings |
| Postgres full-text search | semantic search |
| metadata search | vector similarity |
| project / table / record search | RAG retrieval |
| | AI ranking / recommendation |

When the `search` module lands, keep its full-text/SQL/metadata paths in core and move any embedding/semantic/vector paths to `_deferred/`.

### Admin UI (`apps/admin-ui`) — early v0.1 dashboard

> **Status:** implemented in v0.1, but early. The dashboard ships in `apps/admin-ui`
> and is part of the Compose stack. Core flows work today; several areas listed
> below are still planned.

Next.js dashboard, implemented in `apps/admin-ui`. Communicates with the Platform
API over REST + JWT, using the `@basefyio/sdk` TypeScript client.

**Implemented in v0.1:**
- Login (JWT auth)
- Project list, project create, and project detail
- SQL editor
- Storage bucket management
- Health / status views
- Public no-signup **Playground** at `/playground`

**Planned (not yet shipped):**
- Advanced auth / user management
- Table editor
- Realtime UI
- Full project settings

This is an early dashboard: the CLI and SDK remain the primary interfaces for v0.1.

#### Playground (`/playground`)

A public, no-signup sandbox that lets a visitor experience basefyio in the
browser — run SQL, browse tables, create/insert/delete rows, and inspect the
equivalent REST + SDK calls — without an account, install, or backend.

It runs entirely client-side on **PGlite** (PostgreSQL compiled to WebAssembly),
seeded with a sample dataset on load. Crucially, **the Playground creates no
backend demo infrastructure**: there is no public demo project, no shared demo
database, and no unauthenticated platform-api endpoint. Nothing the visitor
types leaves their browser tab, and "reset" simply re-seeds the in-memory
database. The REST Explorer *shows* the real authenticated
`POST /api/sql/execute` request and `@basefyio/sdk` snippet for each operation,
but does not issue it — so the feature adds zero public attack surface or
hosting cost to the core platform. The SQL editor uses Monaco; the in-browser
guard mirrors the platform-api forbidden-operation denylist.

### Marketing Site (`apps/marketing`)

The public marketing site at **basefyio.com** is a separate, static **Astro**
build in `apps/marketing` — intentionally decoupled from the dashboard. It has
no runtime dependency on the Platform API and is not part of the Compose stack;
it deploys as static assets. The admin dashboard (`apps/admin-ui`) serves the
application only — its `/` route redirects to `/dashboard`, and the public
in-browser Playground lives at `apps/admin-ui` `/playground`. Keeping the
marketing surface in one place (Astro) avoids landing-page drift between the
two apps.

### Auth Provider (Keycloak)

Each project gets a dedicated **Keycloak realm**. The Platform API provisions realms on project creation and validates JWTs using OIDC discovery.

The auth interface is designed to be provider-agnostic — Keycloak is the default but can be replaced by any OIDC-compliant provider.

### Database Layer

- **ORM** — **Prisma** is the single, authoritative database layer for v0.1 (`prisma/` + `PrismaModule` / `PrismaService`). Drizzle is not used in the core runtime.
- **Platform DB** — PostgreSQL instance for platform metadata (projects, API keys, audit logs)
- **Project DBs** — One dedicated PostgreSQL database per project, provisioned at creation time
- **pgvector** — Vector extension available on databases; consumed by the deferred AI stack (agentfyio), not by core
- **PgBouncer** — Connection pooler in front of all project databases

### Queue

BullMQ on Redis. Used for:
- Background provisioning jobs
- Email delivery
- Scheduled tasks

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

## AI Stack (deferred → agentfyio)

AI workloads are **not** part of the basefyio core. They are deferred to **agentfyio**, which will build on basefyio. These capabilities are excluded from v0.1; their source may remain in the private source repository or future MYFYIO repositories rather than in this public repo. The deferred areas are:

- **Embedding** — embedding generation and storage
- **RAG pipeline** — chunking, embedding, retrieval, and generation
- **Agent scaffolding** — tool adapter pattern for AI agent workflows
- **Recommendation** — recommendation features

basefyio core still ships **pgvector** availability on PostgreSQL, so agentfyio (or any consumer) can layer vector workloads on top without the core depending on them — consistent with the one-way Dependency Rule.
