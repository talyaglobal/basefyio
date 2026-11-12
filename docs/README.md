# basefyio documentation

basefyio is a self-hosted backend platform. Every project gets its own PostgreSQL database,
its own authentication realm, object storage buckets, an automatically generated REST API,
a realtime change stream and a set of administration routes — all served by one API under
one domain you control.

This directory is the reference manual. Each page is written from the controller that serves
the routes it describes and names that controller at the bottom, so you can check it against
the code. A jest spec (`apps/platform-api/src/docs/route-coverage.spec.ts`) fails when a
documented route stops existing.

## Where to start

| You want to… | Read |
|---|---|
| Install basefyio on your own server | the Quick Start in the [repository README](../README.md), then [reference/configuration.md](./reference/configuration.md); offline installs: [SELF_HOSTING_OFFLINE.md](./SELF_HOSTING_OFFLINE.md) |
| Build an application against a project | [reference/js-sdk.md](./reference/js-sdk.md) |
| Understand keys, roles and row-level security | [concepts/security-model.md](./concepts/security-model.md) |
| Configure the platform | [reference/configuration.md](./reference/configuration.md) |

## Data API — called by your application with a project key

| Page | Routes |
|---|---|
| [reference/auth-api.md](./reference/auth-api.md) | `/api/rest/v1/auth/*` — sign-up, sign-in, passwordless, OAuth, session |
| [reference/rest-api.md](./reference/rest-api.md) | `/api/rest/v1/:table`, `/api/rest/v1/rpc/:fn` — tables through the PostgREST query grammar |
| [reference/collections-api.md](./reference/collections-api.md) | `/api/rest/v1/collections/*` — document collections |
| [reference/sql-api.md](./reference/sql-api.md) | `POST /api/sql/execute` — SQL with bound parameters |
| [REALTIME_API.md](./REALTIME_API.md) | `/api/realtime/v1/stream`, realtime bindings |
| [reference/storage-api.md](./reference/storage-api.md) | `/api/projects/:projectId/storage/*` — buckets and objects |
| [reference/embeddings-api.md](./reference/embeddings-api.md) | `/api/rest/v1/embeddings/*` — vectors and semantic search |

## Platform API — called with the service key, a dashboard session or an API token

| Page | Routes |
|---|---|
| [reference/project-admin-api.md](./reference/project-admin-api.md) | tables, columns, rows, connection info, indexes, triggers, functions, extensions, export, backups, point-in-time recovery |
| [reference/project-users-api.md](./reference/project-users-api.md) | `/api/projects/:projectId/auth/*` — administering a project's end users |
| [reference/rag-api.md](./reference/rag-api.md) | `/api/projects/:projectId/rag/*` — retrieval over the project's documents |
| [reference/flows-api.md](./reference/flows-api.md) | `/api/projects/:projectId/flows/*` — automation flows |
| [reference/data-engine-api.md](./reference/data-engine-api.md) | `/api/v1/projects/:projectId/*` — schema-flexible entities, queries, structures |
| [reference/billing-api.md](./reference/billing-api.md) | `/api/billing/*` — plans, subscription, usage, invoices |
| [API_TOKENS.md](./API_TOKENS.md) | account API tokens (`bf_pat_…`) and their scopes |
| [CODEFYIO_ADAPTER.md](./CODEFYIO_ADAPTER.md) | the Codefyio IDE adapter at `/_codefyio/*` |
| [integrations/tsmart.md](./integrations/tsmart.md) | platform-to-platform project feed |

## Tools

| Page | Covers |
|---|---|
| [reference/js-sdk.md](./reference/js-sdk.md) | `basefyio-js` — `createClient`, `auth`, `from()`, `sql()`, `rpc()`, `storage`, `collection()`, `data`, `realtime` |
| [reference/cli.md](./reference/cli.md) | `basefyio` / `bf` — login, projects, link, db, gen, migration, secrets, logs, backup, restore |

## Operating

| Page | Covers |
|---|---|
| [SELF_HOSTING_OFFLINE.md](./SELF_HOSTING_OFFLINE.md) | air-gapped installs and serving HTTPS with your own certificate |
| [reference/configuration.md](./reference/configuration.md) | every environment variable the API and dashboard read |
| [guides/health-and-metrics.md](./guides/health-and-metrics.md) | `/api/health`, `/api/metrics`, Traefik health checks |
| [POINT_IN_TIME_RECOVERY.md](./POINT_IN_TIME_RECOVERY.md) | how continuous recovery works and how to restore |
| [BACKUP_OFFSITE_AND_VERIFICATION.md](./BACKUP_OFFSITE_AND_VERIFICATION.md) | off-site backup copies and restore verification |
| [reference/errors.md](./reference/errors.md) | the error envelope and what each status means |

## Conventions used on every page

**Base URL.** Routes are written relative to `https://api.<your-domain>/api`. The hosted
service is `https://api.basefyio.com/api`. Every route of the platform API lives under the
`/api` prefix; the only exception is the Codefyio adapter at `/_codefyio/*`.

**Two kinds of credential.**

- *Project keys* belong to one project and authenticate your application's requests.
  The **anon key** is public — it ships in your browser bundle. The **service key** is secret
  and bypasses row-level security; it is only ever used from your own server. Both are shown
  on the project's Connection page in the dashboard.
- *Account credentials* authenticate a person or an automation acting as one: the dashboard
  session (a Keycloak JWT) or an [API token](./API_TOKENS.md).

**Headers.**

| Header | Used for |
|---|---|
| `apikey: <anon or service key>` | every data-API call. The anon key may also travel as `?apikey=` on routes a browser opens directly (the realtime stream, e-mail links); the service key is refused in a URL. |
| `Authorization: Bearer <access token>` | with the anon key: the signed-in end user's token, which turns the request into the `authenticated` role for row-level security. With a dashboard session or API token: the credential itself. |
| `Prefer: return=representation` | on writes to `/rest/v1`: return the affected rows instead of a count. |
| `Content-Type: application/json` | every JSON body. Uploads are `multipart/form-data`. |

**Authentication tiers.** Each route table has a *Tier* column:

| Tier | Meaning |
|---|---|
| `public` | no credential at all |
| `anon` | any project key |
| `anon + user` | the anon key together with a signed-in end user's Bearer token — or the service key |
| `service` | the service key only; the anon key is refused with 403 |
| `session` | a dashboard session (Keycloak JWT); see each page for whether an API token is also accepted |

**Request limits.** JSON bodies are limited to 10 MB. Request bodies are validated with a
whitelist: a property the route does not know is rejected with `400` and the message
`property <name> should not exist`.

**Rate limit.** 300 requests per minute per client IP across the API, except the data API
(`/rest/v1/*`), which is exempt because it is authorised by the key instead.

**Errors.** Every error is JSON:

```json
{ "statusCode": 403, "message": "This route requires the service key …", "timestamp": "2026-10-20T12:00:00.000Z" }
```

`message` is an array of strings for validation errors. Unexpected failures are always
reported as `500 Internal server error` without detail. See [reference/errors.md](./reference/errors.md).

**CORS.** The API accepts requests from any origin and never uses cookies, so a browser
application needs no proxy. Allowed request headers: `Content-Type`, `Authorization`,
`apikey`, `x-project-id`, `prefer`, `x-client-info`, `x-supabase-api-version`.

Source: `apps/platform-api/src/main.ts`, `apps/platform-api/src/common/guards/api-key.guard.ts`,
`apps/platform-api/src/common/filters/all-exceptions.filter.ts`, `apps/platform-api/src/app.module.ts`.
