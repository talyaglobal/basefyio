# basefyio AI Agent Prompt

> Copy this into your AI assistant (Claude, ChatGPT, Cursor, Copilot, etc.) so it uses your basefyio project correctly — no local database, no made-up URLs.

---

## CRITICAL — No local database

This project uses **basefyio** as its database and backend. All data lives on basefyio — there is NO local database.

- The database is **hosted on basefyio** (see `DATABASE_URL` below). Do **NOT** create, install, or run a local PostgreSQL / SQLite / MySQL / Docker database.
- Do **NOT** run `docker-compose up`, `docker run postgres`, or any command that starts a local database server.
- Do **NOT** change `DATABASE_URL` to `localhost`, `127.0.0.1`, or any local address. The URL below points to your live basefyio project — use it as-is.
- Do **NOT** create a new database. The database already exists on basefyio and may contain production data.
- If a tool suggests "creating a database first", skip that step — the database is already provisioned.

---

## 1) Environment variables

Copy into `.env` or `.env.local` (no quotes around values):

```env
DATABASE_URL=postgresql://USER:PASSWORD@db.basefyio.com:6432/YOUR_DATABASE
DIRECT_URL=postgresql://USER:PASSWORD@db.basefyio.com:6432/YOUR_DATABASE
NEXT_PUBLIC_BASEFYIO_URL=https://api.basefyio.com
NEXT_PUBLIC_BASEFYIO_ANON_KEY=your_anon_key_here
BASEFYIO_SERVICE_ROLE_KEY=your_service_key_here
PROJECT_ID=your_project_id_here
```

> Get the real values from **Connection** page in the [basefyio dashboard](https://app.basefyio.com).

---

## 2) Prisma / Drizzle / ORM setup

- `DATABASE_URL` — connection pooler (for queries at runtime)
- `DIRECT_URL` — direct connection (for migrations and schema pushes)
- Both point to the **remote basefyio database** — never replace them with local URLs.

### Prisma schema

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

generator client {
  provider = "prisma-client-js"
}
```

### Common commands

| Command | What it does |
|---------|-------------|
| `npx prisma db push` | Push schema changes to basefyio (no migration files) |
| `npx prisma migrate dev` | Create and apply a migration on basefyio |
| `npx prisma db pull` | Introspect existing basefyio tables into your schema |
| `npx prisma generate` | Regenerate the Prisma client locally |
| `npx prisma studio` | Open a visual editor connected to basefyio |

All of these run against the **remote basefyio database**, not a local one.

### Drizzle

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

Push with: `npx drizzle-kit push`

---

## 3) Authentication

- basefyio handles auth — do **not** install or run a separate auth server.
- Use the **basefyio-js** SDK for sign-up, sign-in, sign-out, and OAuth:

```bash
npm install basefyio-js
```

```ts
import { createClient } from 'basefyio-js';

const basefyio = createClient({
  apiUrl: process.env.NEXT_PUBLIC_BASEFYIO_URL,
  projectId: process.env.PROJECT_ID,
  apiKey: process.env.NEXT_PUBLIC_BASEFYIO_ANON_KEY,
});

// Sign in
await basefyio.auth.signIn({ email, password });

// Query data
const { data } = await basefyio.from('products').select('*').eq('active', true);
```

---

## 4) API Architecture

basefyio has two API surfaces — understand the difference:

| Endpoint | Base URL | Auth | Who uses it |
|----------|----------|------|-------------|
| **Public REST API** | `https://api.basefyio.com/api/rest/v1/{table}` | `apikey` header | Your app (SDK, curl, fetch) |
| **Platform API** | `https://api.basefyio.com/api/projects/...` | JWT (logged-in user) | Dashboard only |

- **`/api/proxy`** is the admin dashboard's internal Next.js proxy — do **NOT** use it from external projects.
- Your app should call `https://api.basefyio.com/api/rest/v1/{table}` directly with the `apikey` header.

### REST API examples

```bash
# GET — read data
curl 'https://api.basefyio.com/api/rest/v1/products?select=*&active=eq.true&limit=20' \
  -H 'apikey: YOUR_ANON_KEY'

# POST — insert data
curl -X POST 'https://api.basefyio.com/api/rest/v1/products' \
  -H 'apikey: YOUR_SERVICE_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
  -d '{"name": "Widget", "price": 29.99}'

# PATCH — update data
curl -X PATCH 'https://api.basefyio.com/api/rest/v1/products?id=eq.42' \
  -H 'apikey: YOUR_SERVICE_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"price": 24.99}'

# DELETE — remove data
curl -X DELETE 'https://api.basefyio.com/api/rest/v1/products?id=eq.42' \
  -H 'apikey: YOUR_SERVICE_KEY'
```

### Filter syntax

| Filter | Example |
|--------|---------|
| Equality | `?column=eq.value` |
| Not equal | `?column=neq.value` |
| Greater than | `?column=gt.100` |
| Less than | `?column=lt.50` |
| Like (case-insensitive) | `?column=ilike.*search*` |
| In list | `?column=in.(a,b,c)` |
| Select columns | `?select=id,name,price` |
| Order | `?order=created_at.desc` |
| Pagination | `?limit=20&offset=40` |

---

## 5) External database tools

You can connect to your basefyio database from any SQL client:

| Tool | How |
|------|-----|
| **pgAdmin** | Add Server → paste Host, Port, Database, User, Password |
| **DBeaver** | New Connection → PostgreSQL → paste connection details |
| **DataGrip / TablePlus** | Import from URL → paste the Connection URI |
| **Terminal** | `psql "postgresql://USER:PASSWORD@db.basefyio.com:6432/YOUR_DB"` |

---

## 6) Documentation

| Resource | URL |
|----------|-----|
| Docs home | https://basefyio.com/docs |
| API reference | https://basefyio.com/docs/api |
| SDK | https://basefyio.com/docs/sdk |
| CLI | https://basefyio.com/docs/cli |
| External DB access | https://basefyio.com/docs/connect |

---

## 7) Rules for AI agents

### DO
- Use `DATABASE_URL` and `DIRECT_URL` from the env block above — they point to basefyio
- Run `prisma db push` / `prisma migrate dev` against the remote database
- Use `basefyio-js` SDK for auth and data access
- Keep secrets in `.env` (add to `.gitignore`)

### DO NOT
- Create or start a local database (PostgreSQL, SQLite, MySQL, Docker)
- Change `DATABASE_URL` or `DIRECT_URL` to localhost or 127.0.0.1
- Run `docker-compose up` or `docker run postgres`
- Install Supabase CLI or point Supabase clients at basefyio
- Echo secrets in replies or commit `.env` to git
- Invent fake database URLs or API keys
- Tell the user to "create a database" — it already exists
