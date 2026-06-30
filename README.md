# basefyio

**Production-grade, self-hosted backend platform.**  
Deploy your own multi-tenant backend in minutes. Each project gets a dedicated database, isolated authentication, and a secure API — all running on your own infrastructure.

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
- **Secure SQL execution** — validated, audited, timeout-bound query API
- **Modern admin dashboard** — project management, SQL editor, and monitoring
- **CLI** — initialize, manage, and deploy from the terminal
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
| Auth          | Keycloak 24                      |
| Database      | PostgreSQL 16                    |
| Storage       | MinIO                            |
| Orchestration | Docker Compose                   |

---

## Quick Start

**Requires:** Docker & Docker Compose, Node.js 20+

### Using the CLI (Recommended)

```bash
# Install the CLI
npm install -g basefyio-cli

# Clone the repository
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio

# Start everything
basefyio start
```

The CLI starts all services, runs migrations, and launches the platform automatically.

| Service      | URL                          |
|--------------|------------------------------|
| Admin UI     | http://localhost:3000        |
| Platform API | http://localhost:4000        |
| Auth Console | http://localhost:8080        |

Sign in at `http://localhost:3000/login` with `admin` / `admin`.

---

## Manual Installation

### 1. Clone and configure

```bash
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
cp .env.example .env
```

### 2. Start infrastructure

```bash
docker compose up -d
```

Starts PostgreSQL, authentication service, and object storage.

### 3. Start the Platform API

```bash
cd apps/platform-api
cp .env.example .env
npm install
npx prisma migrate dev --name init
npm run start:dev
```

### 4. Start the Admin UI

```bash
cd apps/admin-ui
npm install
npm run dev
```

### 5. Sign in

Open `http://localhost:3000/login` and sign in with `admin` / `admin`.

---

## CLI

The basefyio CLI is the fastest way to manage your platform.

```bash
npm install -g basefyio-cli
```

```bash
basefyio login          # Authenticate with your platform
basefyio init           # Initialize a new project
basefyio start          # Start the full local stack
basefyio db push        # Push schema changes
basefyio db pull        # Pull remote schema
basefyio db reset       # Reset a project database
basefyio logs           # Stream platform logs
basefyio secrets list   # Manage project secrets
```

See [CLI documentation](./packages/cli/README.md) for the full reference.

---

## Repository Structure

```
basefyio/
├── apps/
│   ├── platform-api/    # REST API — auth, projects, SQL, audit
│   └── admin-ui/        # Next.js dashboard
├── packages/
│   └── cli/             # basefyio CLI
├── scripts/             # Database initialization
└── docker-compose.yml
```

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

All API endpoints are secured with JWT validation backed by published JWKS endpoints. The underlying identity provider is Keycloak 24.

---

## Environment Variables

See [`.env.example`](.env.example) for the full list of required and optional configuration values.

---

## Roadmap

- [ ] REST API generation per project
- [ ] Role-based access control (RBAC) per project
- [ ] Webhook support
- [ ] S3-compatible file upload per project
- [ ] Web-based SQL editor enhancements
- [ ] Kubernetes deployment guide
- [ ] SDKs (TypeScript, Python)

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

[MIT](./LICENSE) © basefyio
