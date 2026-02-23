# Architecture

> Detailed architecture documentation for the Kolaybase platform.

Last updated: 2026-02-23

## Table of Contents

- [Overview](#overview)
- [Control Plane](#control-plane)
- [Data Plane](#data-plane)
- [Authentication Flow](#authentication-flow)
- [Project Lifecycle](#project-lifecycle)
- [SQL Execution Pipeline](#sql-execution-pipeline)
- [See Also](#see-also)

## Overview

Kolaybase is a multi-tenant backend-as-a-service platform. It follows a control-plane / data-plane separation:

- **Control plane**: Admin UI + Platform API — manages projects, users, and infrastructure
- **Data plane**: Per-project PostgreSQL databases and Keycloak realms — serves application data and auth

## Control Plane

### Platform API (NestJS)

| Module     | Responsibility                              |
|------------|---------------------------------------------|
| `auth`     | Admin login via Keycloak, JWT validation     |
| `projects` | CRUD, database provisioning, realm creation  |
| `sql`      | Secure query execution against project DBs   |

The API stores metadata in a central `kolaybase` PostgreSQL database via Prisma ORM.

### Admin UI (Next.js)

| Page                | Route                              |
|---------------------|------------------------------------|
| Login               | `/login`                           |
| Project list        | `/dashboard`                       |
| Project detail      | `/dashboard/projects/[id]`         |
| SQL editor          | `/dashboard/projects/[id]/sql`     |

Protected by middleware that checks for a valid JWT cookie.

## Data Plane

Each project consists of:

1. **PostgreSQL database** — named `kb_<slug>`, created on the shared PostgreSQL server
2. **Keycloak realm** — named `kb-<slug>`, with public + service clients

Future additions:
- PostgREST per project (auto-generated REST API)
- Realtime subscriptions via WebSockets
- Storage buckets via MinIO

## Authentication Flow

### Admin Authentication

```
Admin UI → POST /api/auth/login (username, password)
         → Platform API → Keycloak token endpoint (master realm)
         → JWT returned → stored in cookie
         → subsequent requests include Bearer token
         → Platform API validates via Keycloak JWKS
```

### Project User Authentication

```
Client App → Keycloak realm (kb-<slug>) → OIDC / password grant
           → JWT scoped to project realm
           → used for PostgREST / data-plane access (future)
```

## Project Lifecycle

### Creation

1. Validate project name → generate slug
2. `CREATE DATABASE "kb_<slug>"` on PostgreSQL
3. Create Keycloak realm `kb-<slug>`
4. Create public client (`kb-<slug>-anon`)
5. Create confidential client (`kb-<slug>-service`) with secret
6. Store metadata in `projects` table

If Keycloak provisioning fails, the database is rolled back (dropped).

### Deletion

1. Delete Keycloak realm (best-effort)
2. Terminate active connections to project database
3. `DROP DATABASE "kb_<slug>"`
4. Mark project as `DELETED` (soft delete in metadata)

## SQL Execution Pipeline

```
Request → JWT auth guard
        → Validate project ownership
        → Blocklist check (DROP DATABASE, ROLE ops, etc.)
        → Connect to project DB with statement_timeout=30s
        → Execute query
        → Audit log (project, user, query, duration, error)
        → Return results
```

## See Also

- [README](../README.md) — Quick start guide
