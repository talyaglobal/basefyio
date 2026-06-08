# Basefyio

A production-grade, self-hosted, multi-tenant backend platform.  
Each project gets its own PostgreSQL database and Keycloak authentication realm.

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                     Admin UI (Next.js)                │
│   Login · Project list · Project detail · SQL editor  │
└──────────────────────┬────────────────────────────────┘
                       │  REST / JWT
┌──────────────────────▼────────────────────────────────┐
│               Platform API (NestJS)                   │
│   AuthModule · ProjectsModule · SqlModule             │
└───┬───────────────┬───────────────────┬───────────────┘
    │               │                   │
┌───▼───┐     ┌─────▼─────┐      ┌─────▼─────┐
│ Prisma│     │ Keycloak  │      │ Project   │
│  (PG) │     │ Admin API │      │ Databases │
└───────┘     └───────────┘      └───────────┘
```

## Tech Stack

| Layer         | Technology                      |
|---------------|---------------------------------|
| Admin UI      | Next.js 14, Tailwind, shadcn/ui |
| Platform API  | NestJS, Prisma, TypeScript      |
| Auth          | Keycloak 24 (admin API)         |
| Database      | PostgreSQL 16                   |
| Storage       | MinIO                           |
| Orchestration | Docker Compose                  |

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js 20+
- npm or pnpm

### Option 1: Using CLI (Recommended)

```bash
# Install CLI
npm install -g basefyio-cli

# Clone repository
git clone <repo-url> basefyio && cd basefyio

# Start everything with one command
basefyio start
```

The CLI will:
- Start Docker services (PostgreSQL, Keycloak, MinIO)
- Install dependencies
- Run migrations
- Start Platform API (http://localhost:4000)
- Start Admin UI (http://localhost:3000)

Login at `http://localhost:3000/login` with credentials: `admin` / `admin`

### Option 2: Manual Setup

### 1. Clone & configure

```bash
git clone <repo-url> basefyio && cd basefyio
cp .env.example .env
```

### 2. Start infrastructure

```bash
docker compose up -d
```

This starts PostgreSQL, Keycloak, and MinIO.  
Keycloak admin console: `http://localhost:8080` (admin / admin).

### 3. Set up the Platform API

```bash
cd apps/platform-api
cp .env.example .env
npm install
npx prisma migrate dev --name init
npm run start:dev
```

The API runs on `http://localhost:4000`.

### 4. Set up the Admin UI

```bash
cd apps/admin-ui
npm install
npm run dev
```

The UI runs on `http://localhost:3000`.

### 5. First login

Sign in at `http://localhost:3000/login` with your Keycloak master-realm admin credentials (default: `admin` / `admin`).

## Basefyio CLI

We provide a powerful CLI tool (similar to common hosted Postgres CLIs) for managing your Basefyio projects:

```bash
# Install CLI globally
npm install -g basefyio-cli

# Quick start
basefyio login
basefyio init
basefyio start
```

**Key features:**
- 🚀 Project initialization and management
- 🐳 Local development environment (Docker)
- 🗄️ Database operations (push, pull, reset, seed)
- 🔧 Code generation (TypeScript types, API clients)
- 📊 Logs and monitoring
- 🔑 Secrets management

See [CLI documentation](./packages/cli/README.md) for details.

## Project Structure

```
basefyio/
├── docker-compose.yml
├── scripts/
│   └── init-db.sql
├── apps/
│   ├── platform-api/          # NestJS backend
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── src/
│   │       ├── main.ts
│   │       ├── app.module.ts
│   │       ├── config/
│   │       ├── common/        # Guards, filters, interceptors
│   │       ├── prisma/        # Prisma service
│   │       └── modules/
│   │           ├── auth/      # Keycloak integration + JWT
│   │           ├── projects/  # CRUD + DB + realm provisioning
│   │           └── sql/       # Secure SQL execution + audit
│   └── admin-ui/              # Next.js frontend
│       ├── app/
│       │   ├── login/
│       │   └── dashboard/
│       ├── components/
│       │   └── ui/            # shadcn/ui primitives
│       └── lib/               # API client, auth, types
├── packages/
│   └── cli/                   # Basefyio CLI
│       ├── src/
│       │   ├── commands/      # All CLI commands
│       │   └── lib/           # Utilities and API client
│       └── README.md
└── README.md
```

## Key Concepts

### Project Provisioning

When you create a project, the platform:

1. Creates a dedicated PostgreSQL database (`basefyio_<slug>`)
2. Creates a Keycloak realm (`basefyio-<slug>`)
3. Provisions a public client (anon) and a confidential service client
4. Returns `anonKey` and `serviceKey` for downstream use

### SQL Execution

All SQL runs through the `/api/sql/execute` endpoint. Every query is:

- Validated against a blocklist (no `DROP DATABASE`, role mutations, etc.)
- Executed with a 30-second timeout
- Fully audited (user, query, duration, result/error)

### Authentication

- **Admin users** authenticate via Keycloak's master realm (password grant → JWT)
- **End users** (of projects) authenticate via per-project Keycloak realms
- All API endpoints are protected by a JWT guard backed by Keycloak JWKS

## Environment Variables

See [`.env.example`](.env.example) for the full list.

## License

Private — all rights reserved.
