# basefyio

**The open-source backend platform. Self-hosted. PostgreSQL-first.**

basefyio is an open-source infrastructure platform that gives every project its own dedicated PostgreSQL database, isolated authentication, secure API, and developer tooling — all running on your infrastructure.

> **Project status:** Early development. The platform architecture and Docker stack are defined; the `apps/*` and `packages/*` are being built out. Not yet recommended for production.

---

## Why basefyio?

Most backend platforms are cloud-only, opinionated, or difficult to operate in production.

basefyio is built for teams that need:

- **Full data ownership** — nothing leaves your servers
- **Project isolation by design** — each project gets its own database and auth realm
- **Multi-tenant from day one** — manage hundreds of projects from a single platform
- **Self-hostable in minutes** — one `docker compose up` and you're running

Philosophically similar to [Supabase](https://supabase.com), [PocketBase](https://pocketbase.io), [Appwrite](https://appwrite.io), and [Coolify](https://coolify.io) — but focused on multi-tenant project provisioning as the core primitive.

---

## Features

| Feature | Description |
|---|---|
| **Project Provisioning** | Each project gets a dedicated PostgreSQL database, isolated auth realm, and API namespace |
| **SQL Engine** | Validated, audited, timeout-bound SQL execution with RLS support |
| **Authentication** | JWT-secured API with pluggable auth provider (Keycloak by default) |
| **Storage** | Per-project object storage via MinIO |
| **Realtime** | Server-sent events for live data subscriptions |
| **Data Engine** | Structured data layer with type-safe query builder |
| **AI-Ready** | Built-in vector embedding support (pgvector), RAG pipeline, agent scaffolding |
| **Queue** | Background job processing with BullMQ + Redis |
| **Admin UI** | Project management dashboard, SQL editor, and audit log viewer |
| **CLI** | Terminal-first project management and deployment |
| **Docker-first** | Full local stack via Docker Compose with PgBouncer connection pooling |
| **Observable** | Health checks, audit logging, trace IDs, and structured logs |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Admin Dashboard                      │
│         Login · Projects · SQL Editor · Logs            │
└──────────────────────────┬──────────────────────────────┘
                           │  REST / JWT
┌──────────────────────────▼──────────────────────────────┐
│                      Platform API                        │
│   Auth · Projects · SQL · Storage · Realtime · Queue    │
└────────┬──────────────────┬───────────────┬─────────────┘
         │                  │               │
   ┌─────▼──────┐   ┌───────▼──────┐  ┌────▼──────────┐
   │  Platform  │   │     Auth     │  │   Project     │
   │  Database  │   │   Provider   │  │  Databases    │
   │ (Postgres) │   │  (Keycloak)  │  │ (Postgres x N)│
   └────────────┘   └──────────────┘  └───────────────┘
         │
   ┌─────▼──────┐   ┌──────────────┐  ┌───────────────┐
   │   Redis    │   │    MinIO     │  │  PgBouncer    │
   │  (Queue)   │   │  (Storage)   │  │ (Conn Pool)   │
   └────────────┘   └──────────────┘  └───────────────┘
```

### Core Modules

| Module | Responsibility |
|---|---|
| `projects` | Project lifecycle: create, list, archive |
| `provisioning` | Database and auth realm provisioning per project |
| `auth` | JWT validation, API key management, OIDC bridge |
| `sql` | Safe SQL execution with validation and audit trail |
| `data-engine` | Structured schema and query layer |
| `data-query` | Type-safe query builder |
| `storage` | Object storage with per-project namespacing |
| `realtime` | SSE-based live subscriptions |
| `queue` | BullMQ-powered background jobs |
| `agent` | AI agent scaffolding with tool adapters |
| `rag` | Retrieval-augmented generation pipeline |
| `embedding` | Vector embedding management (pgvector) |
| `search` | Full-text and semantic search |
| `observability` | Structured logging, trace IDs, audit log |
| `health` | Readiness and liveness probes |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Platform API | NestJS, TypeScript, Drizzle ORM |
| Admin UI | Next.js 14, Tailwind CSS, shadcn/ui |
| Auth Provider | Keycloak 24 (pluggable) |
| Database | PostgreSQL 16 + pgvector |
| Object Storage | MinIO |
| Queue / Cache | Redis 7 + BullMQ |
| Connection Pool | PgBouncer |
| Orchestration | Docker Compose |

---

## Quick Start

**Requirements:** Docker, Docker Compose, Node.js 20+

### 1. Clone and start

```bash
git clone https://github.com/myfyio/basefyio.git
cd basefyio
cp .env.example .env
docker compose up -d
```

### 2. Access the platform

| Service | URL | Default credentials |
|---|---|---|
| Admin UI | http://localhost:3000 | admin / admin |
| Platform API | http://localhost:4000 | — |
| Keycloak | http://localhost:8080 | admin / admin |
| MinIO Console | http://localhost:9001 | minioadmin / minioadmin |

### 3. Create your first project

```bash
# Via CLI
npx @basefyio/cli project create my-app

# Via API
curl -X POST http://localhost:4000/projects \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "slug": "my-app"}'
```

### 4. Connect your app

```bash
npm install @basefyio/sdk
```

```ts
import { createClient } from '@basefyio/sdk'

const client = createClient({
  url: 'http://localhost:4000',
  projectSlug: 'my-app',
  apiKey: 'your-api-key'
})

const { data } = await client.sql('SELECT * FROM users LIMIT 10')
```

---

## Docker Compose

The default `docker-compose.yml` starts the full local stack:

```
postgres       — Platform database (port 5433)
keycloak       — Auth provider (port 8080)
redis          — Queue and cache (port 6379)
minio          — Object storage (port 9000 / 9001)
pgbouncer      — Connection pooler (port 5432)
platform-api   — Core API (port 4000)
admin-ui       — Dashboard (port 3000)
```

The compose stack includes health checks, volume mounts, and service dependencies. Harden it for your environment before any production use.

---

## Repository Structure

```
basefyio/
├── apps/
│   ├── platform-api/          # NestJS core API
│   │   └── src/modules/
│   │       ├── projects/      # Project management
│   │       ├── provisioning/  # Database provisioning
│   │       ├── auth/          # JWT & API key auth
│   │       ├── sql/           # SQL execution engine
│   │       ├── data-engine/   # Structured data layer
│   │       ├── storage/       # Object storage
│   │       ├── realtime/      # SSE subscriptions
│   │       ├── queue/         # Background jobs
│   │       ├── agent/         # AI agent scaffolding
│   │       ├── rag/           # RAG pipeline
│   │       ├── embedding/     # Vector embeddings
│   │       └── observability/ # Logging & tracing
│   └── admin-ui/              # Next.js dashboard
├── packages/
│   ├── cli/                   # @basefyio/cli
│   ├── sdk/                   # @basefyio/sdk client SDK
│   ├── auth/                  # @basefyio/auth
│   ├── storage/               # @basefyio/storage
│   ├── runtime/               # @basefyio/runtime (shared internals)
│   ├── react/                 # @basefyio/react bindings
│   └── next/                  # @basefyio/next bindings
├── examples/                  # Example apps
├── templates/                 # Starter templates
├── docker/                    # Service configs (Keycloak, etc.)
├── docs/                      # Documentation
├── scripts/                   # Setup and migration scripts
├── pnpm-workspace.yaml        # Workspace definition
├── package.json               # Root workspace manifest
└── docker-compose.yml         # Full local stack
```

### Packages

Published under the `@basefyio` npm scope. All packages are early-stage scaffolds — not yet released.

| Package | Path | Purpose |
|---|---|---|
| `@basefyio/cli` | `packages/cli` | Terminal-first project management |
| `@basefyio/sdk` | `packages/sdk` | Type-safe client SDK |
| `@basefyio/auth` | `packages/auth` | Auth helpers and token handling |
| `@basefyio/storage` | `packages/storage` | Object storage client |
| `@basefyio/runtime` | `packages/runtime` | Shared runtime internals |
| `@basefyio/react` | `packages/react` | React hooks and components |
| `@basefyio/next` | `packages/next` | Next.js integration |

---

## Authentication

basefyio uses **Keycloak** as the default authentication provider. Each project gets its own isolated Keycloak realm, meaning users, roles, and sessions are completely separated between projects.

The auth architecture is designed to be provider-agnostic:

- The Platform API validates JWTs using standard OIDC discovery
- The `auth` module abstracts provider-specific calls behind a service interface
- Alternative providers (Auth0, custom OIDC) can be wired in by implementing the interface

---

## Project Provisioning

When you create a project, basefyio:

1. Creates a dedicated PostgreSQL database
2. Provisions a Keycloak realm with a configured client
3. Registers the project in the platform database
4. Returns connection credentials and API keys

This means zero cross-project data leakage at the database level.

---

## SQL Engine

The SQL module provides safe, audited query execution:

- **Validation** — rejects dangerous statements before execution
- **Audit log** — every query is logged with user, timestamp, and duration
- **Timeout** — configurable per-query execution timeout
- **RLS** — Row-Level Security policies enforced at the database level
- **pgvector** — first-class vector type support for AI workloads

---

## Roadmap

- [ ] `@basefyio/cli` — full project lifecycle management
- [ ] `@basefyio/sdk` — type-safe client SDK with realtime support
- [ ] GraphQL API layer
- [ ] WASM-powered SQL validation (client-side)
- [ ] Kubernetes Helm chart
- [ ] Plugin system for custom modules
- [ ] UI-based schema editor
- [ ] Webhooks
- [ ] Scheduled jobs (cron)
- [ ] Log streaming via SSE

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

Areas where help is most needed:

- **Documentation** — guides, examples, API reference
- **SDK** — `@basefyio/sdk` client library
- **CLI** — `@basefyio/cli` command coverage
- **Tests** — integration and e2e coverage
- **Docker** — Kubernetes and Helm support
- **Auth providers** — alternative OIDC provider adapters

---

## Community

- [GitHub Discussions](https://github.com/myfyio/basefyio/discussions) — questions and ideas
- [GitHub Issues](https://github.com/myfyio/basefyio/issues) — bugs and feature requests
- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

basefyio is open-source software. A hosted cloud version is available at [basefy.io](https://basefy.io).
