# basefyio

> **The open-source, self-hosted backend platform you fully own.**

[![Status: beta](https://img.shields.io/badge/status-beta-f59e0b.svg)](#)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)
[![Stars](https://img.shields.io/github/stars/talyaglobal/basefyio?style=social)](https://github.com/talyaglobal/basefyio/stargazers)

Deploy your own **multi-tenant backend-as-a-service** in minutes. Every project gets a dedicated
**PostgreSQL** database, isolated authentication, object storage, and an auto-generated **REST API** —
all running on **your own infrastructure**, with no vendor lock-in and no data leaving your servers.

basefyio is built for teams who want full ownership of their backend: per-project database
isolation, JWT-secured APIs, audit logging, an admin dashboard, a CLI, and a TypeScript SDK.
The server and dashboard are open source under the **AGPL-3.0-or-later**; the client SDK and CLI
you install into your own app stay **MIT**, so building on basefyio never imposes the AGPL on
your code. See [COPYRIGHT.md](./COPYRIGHT.md).

---

## Why basefyio?

Most backend platforms are either cloud-only, too opinionated, or hard to self-host properly.

basefyio gives you:

- **Full ownership** — runs entirely on your infrastructure
- **Isolation by design** — every project has its own database and auth realm
- **Developer experience** — CLI, dashboard, and REST API out of the box
- **Production-ready defaults** — audit logging, SQL validation, JWT-secured endpoints

---

## Features

- **Dedicated PostgreSQL database per project** — no shared schemas, no cross-project risk
- **Built-in authentication** — isolated identity per project, JWT-secured API
- **Multi-tenant architecture** — manage many projects from a single platform
- **Role-based access control** — per-team and per-project roles and permissions
- **Auto REST API per project** — a PostgREST-compatible data API over your tables, served per project
- **Flexible data engine** — relational tables and schema-flexible document collections
- **Object storage** — S3-compatible per-project file storage and uploads
- **Secure SQL execution** — validated, audited, timeout-bound query API
- **AI-powered search** — embeddings, semantic search, and retrieval-augmented (RAG) queries
- **Automation flows** — trigger-and-action workflows on a background job queue
- **App Builder** — turn a spreadsheet into real database tables and a schema you can migrate
- **Billing & subscriptions** — plans, usage, and metered limits
- **Import from Supabase** — migrate an existing Supabase project (schema, data, and users)
- **Optional infrastructure provisioning** — provision compute through pluggable cloud providers
- **Background jobs & caching** — async processing, scheduling, and a shared cache layer
- **Modern admin dashboard** — project management, SQL editor, data browser, and monitoring
- **Row-level security policy editor** — switch RLS on or off per table and create, edit or drop policies from the dashboard (Database → Policies) with templates, a SQL preview and a rolled-back "check against database" run; policies still accept hand-written SQL in the SQL editor.
- **Realtime** — change events for enabled tables and collections, presence (who is on a channel) and client-to-client broadcast over one SSE stream; fan-out through Redis so several API instances serve a project; row-level security applied per subscriber on tables that have it. See [docs/REALTIME_API.md](docs/REALTIME_API.md).
- **Read-only database role** — every new project also gets `<dbUser>_readonly`, a SELECT-only login for BI and reporting tools (it sees every row, like the owner, and can write nothing). Existing projects create it under Connection → Read-only access; the credentials come back from `GET /projects/:id/connect` as `readonly`.
- **Default extensions** — new project databases start with pg_trgm, pgcrypto, unaccent, btree_gist, uuid-ossp and vector (pg_stat_statements where the server preloads it). Database → Extensions → "Install recommended extensions" adds the same set to an existing project.
- **Per-project pooler limits** — `Project.maxDbConnections`, `Plan.maxDbConnections` or `PGBOUNCER_DEFAULT_MAX_DB_CONNECTIONS` set `pool_size` and `max_db_connections` per database in PgBouncer; unset everywhere, the pooler configuration is unchanged.
- **TypeScript SDK & CLI** — manage and integrate from code or the terminal
- **Docker-first** — one command to start the full stack locally
- **Self-hosted** — no vendor lock-in, no data leaving your servers

---

## Architecture

```
┌──────────────────────────────────────────────┐
│               Admin Dashboard                │
│     Login · Projects · SQL Editor · Logs     │
└──────────────────────┬───────────────────────┘
                       │  REST / JWT
┌──────────────────────▼───────────────────────┐
│                 Platform API                 │
│        Auth · Projects · SQL · Audit         │
└────────┬──────────────┬──────────────┬───────┘
         │              │              │
   ┌─────▼─────┐  ┌─────▼─────┐  ┌───▼───────┐
   │  Platform │  │   Auth    │  │  Project  │
   │ Database  │  │  Service  │  │ Databases │
   └───────────┘  └───────────┘  └───────────┘
```

---

## Tech Stack

| Layer         | Technology                       |
|---------------|----------------------------------|
| Admin UI      | Next.js 14, Tailwind, shadcn/ui  |
| Platform API  | NestJS, Prisma, TypeScript       |
| Auth          | Built-in (OpenID Connect)        |
| Database      | PostgreSQL 16                    |
| Storage       | MinIO                            |
| Orchestration | Docker Compose                   |

---

## Quick Start

**Requires:** Docker & Docker Compose v2. Node.js 20+ only if you run the apps outside Docker.

### Run the whole stack with Docker Compose

```bash
# Clone the repository
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio

# Configure — set every secret, including DB_CRED_ENC_KEY (openssl rand -base64 32)
cp .env.example .env

# Build and start everything
docker compose up -d --build
```

`docker-compose.yml` builds the API, dashboard and website from source and starts PostgreSQL
(pgvector), Keycloak, Redis, MinIO and PgBouncer next to them. Project creation needs
`DB_CRED_ENC_KEY` set in `.env`; the API refuses to store a project credential it cannot encrypt.

| Service        | URL                          |
|----------------|------------------------------|
| Admin UI       | http://localhost:3000        |
| Platform API   | http://localhost:4000/api    |
| Keycloak       | http://localhost:8080        |
| MinIO console  | http://localhost:9001        |

Sign in at `http://localhost:3000/login` with `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD`
from your `.env` (the defaults are `admin` / `admin`).

Serving HTTPS with your own certificate (internal CA, offline network):
`docker compose --profile tls up -d` with `DOMAIN`, `TLS_CERT_FILE` and `TLS_KEY_FILE` set in `.env`.
Air-gapped installs: bundle the images with `scripts/bundle-images.sh`, load them with
`scripts/load-images.sh` — see [docs/SELF_HOSTING_OFFLINE.md](docs/SELF_HOSTING_OFFLINE.md).

Both compose files pass an explicit list of variables into the API container, so a setting
that appears only in `.env` may never reach it. [docs/reference/configuration.md](./docs/reference/configuration.md)
lists every variable, which compose file passes it, and how to pass the rest.

---

## Manual Installation (apps outside Docker)

### 1. Clone and configure

```bash
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
cp .env.example .env
```

### 2. Start the infrastructure only

```bash
docker compose up -d postgres keycloak redis redis-queue minio pgbouncer
```

Postgres is published on `localhost:5433`, Keycloak on `8080`, MinIO on `9000`/`9001`, Redis on `6379`.

### 3. Start the Platform API

```bash
cd apps/platform-api
# Create apps/platform-api/.env from the root .env, pointing hosts at the published ports:
#   DATABASE_URL=postgresql://<user>:<password>@localhost:5433/kolaybase
#   POSTGRES_HOST=localhost  POSTGRES_PORT=5433  KEYCLOAK_URL=http://localhost:8080
#   MINIO_ENDPOINT=localhost REDIS_URL=redis://localhost:6379  DB_CRED_ENC_KEY=<32 random bytes, base64>
npm install
npx prisma generate
npx prisma db push
npm run start:dev
```

The platform schema is applied with `prisma db push` — the same step the API container runs on
every start — so there is no separate migration command.

### 4. Start the Admin UI

```bash
cd apps/admin-ui
npm install
npm run dev
```

### 5. Sign in

Open `http://localhost:3000/login` and sign in with the Keycloak admin credentials from your `.env`.

---

## CLI

The basefyio CLI manages projects, schema and credentials from the terminal.

```bash
npm install -g basefyio-cli
```

```bash
basefyio login          # Sign in through your browser
basefyio init           # Create a project and link it to the current directory
basefyio link           # Link an existing project instead
basefyio status         # Keys and connection info of the linked project
basefyio db push        # Push a local schema (Prisma or SQL) to the project database
basefyio db pull        # Introspect the remote schema and save it locally
basefyio db reset       # Drop all tables in the project database
basefyio gen types      # Generate TypeScript types from the live schema
basefyio secrets list   # Manage the project's local .env variables
```

- `basefyio backup create|list|status|download` and `basefyio restore <file.zip | backup ref>` — take, list, fetch and restore full project backups (database, auth users, storage objects, configuration). These commands ship with CLI 2.1.0, the version in this repository; the published npm package is 2.0.3 at the time of writing.

See [docs/reference/cli.md](./docs/reference/cli.md) for the full reference.

---

## Repository Structure

```
basefyio/
├── apps/
│   ├── platform-api/    # REST API — auth, projects, SQL, data, audit, billing, AI, provisioning
│   ├── admin-ui/        # Next.js admin dashboard
│   └── website/         # Public marketing site
├── packages/
│   ├── cli/             # basefyio CLI
│   ├── sdk/             # TypeScript SDK
│   └── data-engine/     # Schema-flexible document/data engine
├── scripts/             # Database initialization & maintenance
└── docker-compose.yml
```

---

## Capabilities in detail

### Storage

- **Bring your own object store.** `STORAGE_DRIVER=minio` (default) uses the bundled MinIO. `STORAGE_DRIVER=s3` with `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY` and `S3_SECRET_KEY` points the API at AWS S3, Cloudflare R2 (`S3_REGION=auto`, `S3_BUCKET_POLICIES=false`), Hetzner Object Storage or any other S3-compatible service. Existing `MINIO_*` settings keep working unchanged.
- **Image transforms on read.** `GET /api/projects/:id/storage/buckets/:bucket/objects/render?path=<key>&width=&height=&format=webp&quality=&fit=` resizes and re-encodes images (jpeg, png, webp, avif) with ETag/304 handling and cache headers. The SDK builds the URL: `bf.storage.from('avatars').getPublicUrl(path, { transform: { width: 200, format: 'webp' } })`.
- **Large uploads.** Single-request uploads up to 500 MB (`STORAGE_MAX_UPLOAD_MB`) are spooled to disk and streamed to the store, never held in memory. Resumable uploads — `POST .../upload-sessions`, chunked `PATCH` with an `Upload-Offset` header, `POST .../complete` — handle files up to 5 GB and survive dropped connections; the SDK offers `uploadResumable(path, file, { onProgress })` and `resumeUpload(sessionId, file)`.
- **Access rules per bucket or prefix.** `PUT /api/projects/:id/storage/buckets/:bucket/policy { "mode": "authenticated-read" | "owner-only", "pathPrefix": "" }` restricts what API-key callers may read, delete or overwrite; uploads record the signed-in uploader as `x-amz-meta-owner`. The service key and dashboard members are never restricted, and a bucket without a rule behaves exactly as before.

The storage, realtime, MFA and pooler settings above are read by the API from its environment;
see [docs/reference/configuration.md](./docs/reference/configuration.md) for passing them through compose.

### Embeddings

Embeddings can be produced by OpenAI (default), a self-hosted Ollama server or Cohere. Set `EMBEDDING_PROVIDER`
and `EMBEDDING_MODEL` for the platform, or pick a provider per project on the project's AI / Embeddings page.
Models narrower than the store's 1536 dimensions are stored zero-padded (cosine distance is unchanged); wider
models are refused. Switching a project's model re-embeds its existing vectors after confirmation.
`GET /projects/:id/ai/disclosure` (and `GET /rest/v1/embeddings/disclosure` with an API key) reports the
provider, model, vector width and the country the text is sent to; set `PLATFORM_REGION` (e.g. `DE`) so the
self-hosted/storage region is stated instead of "not specified".

### Two-factor sign-in (authenticator apps)

```ts
const res = await client.auth.signIn({ email, password });
if (res.mfa) {
  // ask the person for the 6-digit code from their authenticator app
  await client.auth.verifyMfa(res.mfa.challengeId, code);          // or (…, recoveryCode, { recovery: true })
}

// Enrolling (signed-in user): show `otpauthUrl` as a QR code, then confirm with the first code.
const { data: enrollment } = await client.auth.enrollMfa();
const { data } = await client.auth.verifyMfaEnrollment(firstCode); // data.recoveryCodes — show once
```

Administrators can require enrollment per user (Authentication → Users → "Require MFA enrollment") and, under Settings, enforce it at sign-in. Secrets are stored encrypted with `DB_CRED_ENC_KEY`.

### Anonymous users

Enable "Allow anonymous sign-in" under Authentication → Settings, then:

```ts
await client.auth.signInAnonymously();                 // tokens carry is_anonymous: true
await client.auth.upgradeAnonymous({ email, password }); // same user id, now a real account
```

In row-level policies: `coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)` tells anonymous sessions apart, e.g. to deny them writes.

MFA and anonymous sign-in need `basefyio-js` 2.3.0, the version in this repository; the
published npm package is 2.2.0 at the time of writing.

### Importing from Supabase

- Every import and sync reports a per-table reconciliation (rows at the source, rows imported, rows here, primary-key state); it is shown in the import result and on the project's import log.
- Tables imported over the API alone are created with their primary key and serial sequences. Already-imported tables without a key can be repaired from the import log ("Add missing primary keys": preview, then apply) or by ticking "Add missing primary keys before comparing" on a sync.

### Client libraries

- **Python** — [`packages/sdk-python`](packages/sdk-python) (`import basefyio`). Not yet published to PyPI; install from the repo: `pip install -e packages/sdk-python`.

---

## Project Provisioning

When you create a project, basefyio automatically:

1. Creates a dedicated PostgreSQL database (`basefyio_<slug>`)
2. Provisions an isolated authentication realm
3. Generates an anonymous key (`anonKey`) and a service key (`serviceKey`)
4. Returns credentials ready for use in your application

Every project is fully isolated — at the database level, the auth level, and the API level.

---

## SQL Execution

All SQL runs through a single, secure endpoint: `POST /api/sql/execute`.

Every query is:

- **Validated** — blocked operations include `DROP DATABASE`, role mutations, and other destructive statements
- **Time-bound** — hard 30-second execution limit
- **Audited** — every query is logged with user, timestamp, duration, and result

This gives you a safe, observable SQL interface without exposing raw database access.

---

## Authentication

basefyio uses a two-tier authentication model.

**Platform administrators** authenticate through the platform's own identity provider. These users manage projects, configure settings, and access the admin dashboard.

**Application users** authenticate inside their own isolated project realm. Each project gets a dedicated identity space — users, roles, and tokens are completely separated across projects.

All API endpoints are secured with JWT validation backed by published JWKS endpoints, using a standard OpenID Connect identity provider under the hood.

---

## Environment Variables

See [`.env.example`](.env.example) for the annotated template and
[docs/reference/configuration.md](./docs/reference/configuration.md) for what every variable does.

---

## Documentation

- [docs/README.md](./docs/README.md) — index of the reference manual: every API module, the CLI,
  the JavaScript SDK, configuration, the security model and the error reference.
- [docs/reference/configuration.md](./docs/reference/configuration.md) — every environment variable.
- [docs/SELF_HOSTING_OFFLINE.md](./docs/SELF_HOSTING_OFFLINE.md) — air-gapped installs and your own
  TLS certificate.
- [docs/BACKUP_OFFSITE_AND_VERIFICATION.md](./docs/BACKUP_OFFSITE_AND_VERIFICATION.md) and
  [docs/POINT_IN_TIME_RECOVERY.md](./docs/POINT_IN_TIME_RECOVERY.md) — backups and recovery.

---

## Roadmap

Already shipped (see **Features**): auto REST API per project, per-project RBAC,
S3-compatible file storage, realtime change subscriptions, the TypeScript SDK, and the
web-based SQL editor.

Planned next:

- [ ] Outbound webhooks
- [ ] Publish the Python client to PyPI
- [ ] End-to-end test suite across the dashboard and critical user journeys
- [ ] Kubernetes deployment guide
- [ ] Mutual-TLS database gateway (client certificates) for external access

---

## Contributing

Pull requests are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before you start, and see our [Code of Conduct](./CODE_OF_CONDUCT.md).

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Open a pull request

For significant changes, please open an issue first to discuss what you'd like to change.

---

## Security

Found a vulnerability? Please **do not** open a public issue — see [SECURITY.md](./SECURITY.md) for responsible disclosure.

---

## License

Copyright (C) 2026 basefyio

- **Server and dashboard** (`apps/`) — [AGPL-3.0-or-later](./LICENSE). If you run a modified
  version as a network service, you must offer its source to your users (AGPL section 13).
- **Client libraries** (`packages/sdk`, `packages/cli`, `packages/geo`) — MIT, so your own
  application is never forced to adopt the AGPL.

Full details in [COPYRIGHT.md](./COPYRIGHT.md).
