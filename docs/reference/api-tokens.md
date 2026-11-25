# API Tokens

**API tokens** let your scripts and AI agents drive your basefyio **account and
projects** programmatically — creating projects, running SQL, managing storage,
auth, realtime and more — without logging into the dashboard. You choose exactly
what each token can do (its **scopes**), so you can hand an agent a token that can,
say, run SQL but not delete projects.

> **Two different credentials — don't confuse them:**
> - **API tokens** (this page, `bf_pat_…`) — **account/control-plane**. Manage your
>   projects and account. Created under **Account → API Tokens**.
> - **Project keys** (`anon` / `service_role`, per project) — **data-plane**. Used by
>   your app/SDK against one project's `/rest/v1`, `/sql`, `/storage`. Found under a
>   project's **Connection** page.

---

## Creating a token

1. Go to **Account → API Tokens** (left sidebar).
2. Click **Create Token**.
3. Give it a **name** (e.g. "orders-agent"), pick the **scopes** it needs, and
   optionally set a **team** restriction and an **expiry date**.
4. Click **Create** — the full token (`bf_pat_…`) is shown **once**. Copy it now;
   for security it is never displayed again. If you lose it, **roll** the token to
   get a new secret.

Give each token the **fewest scopes** it needs. Prefer short expiries for automation.

## Scopes

Tokens are scoped as `resource:action`. The catalogue a token can be created with
(`apps/platform-api/src/modules/api-tokens/api-tokens.constants.ts`):

| Scope | Grants |
|---|---|
| `account:read` / `account:write` | read your profile and teams · update profile and notification preferences |
| `team:read` / `team:write` | list teams, members, invitations · invite, remove, change member roles |
| `billing:read` / `billing:write` | read plan, subscription, usage, invoices · reserved: plan and payment changes need a dashboard session |
| `projects:read` / `projects:write` | list/inspect · create, rename, deactivate, restore, delete |
| `settings:read` / `settings:write` | project settings, folders and tags |
| `data:read` / `data:write` | read rows and documents · insert, update, delete |
| `schema:read` / `schema:write` | inspect tables, collections and objects · create/alter/drop them |
| `sql:read` | read-only SQL: one SELECT-style statement in a read-only transaction that is never committed |
| `sql:run` | any SQL as the database owner, including writes and destructive statements such as DROP |
| `embeddings:read` / `embeddings:write` | vector search · build and update embedding indexes |
| `storage:read` / `storage:write` | list/download · upload/delete buckets and objects |
| `auth:read` / `auth:write` | list realm users/sessions · create/update/reset users, repair the realm |
| `realtime:read` / `realtime:write` | list bindings · enable/disable broadcasting |
| `flows:read` / `flows:write` | list flows and runs · create, edit, trigger |
| `functions:read` / `functions:write` | functions and their logs · deploy, update, invoke |
| `blueprints:read` / `blueprints:write` | list · analyze, approve, generate (App Builder) |
| `integrations:read` / `integrations:write` | list · connect and disconnect integrations |
| `backups:read` / `backups:write` | list backups and export jobs · create, export, restore |
| `secrets:read` / `secrets:write` | read project keys and connection info · rotate them |
| `logs:read` | activity history and logs |

A **read** call needs the matching `:read` scope; a **write/mutating** call needs
`:write` (or `sql:run` for SQL). A request whose token lacks the scope returns **403**
(`API token is missing required scope(s): …`).

## Where a token is accepted

Every management controller of the API is classified for tokens, and a token is refused
everywhere it has not been explicitly allowed:

- A route that takes tokens names the scope it needs. `GET` routes need the area's `:read` scope;
  `POST`, `PUT`, `PATCH` and `DELETE` need its `:write` scope. A token without it gets **403**
  `API token is missing required scope(s): …`.
- A route that does not name a scope refuses every token with **403**
  `API tokens are not accepted on this route; it needs a dashboard session.`, whatever scopes the
  token holds. The same answer comes from dashboard-only routes and from the data-plane routes
  that take a dashboard session or a project key.

| Area | Routes | Scopes |
|---|---|---|
| Projects | `/api/projects`, `/api/projects/:id` (create, list, inspect, rename, deactivate, reactivate, sleep, trash, restore, delete), Supabase and archive imports, `/api/projects/:id/branches` | `projects:read` / `projects:write` |
| Project settings | `/api/projects/:id/max-rows`, `/api/projects/:id/db-connection-limit`, `/api/project-folders`, `/api/project-tags`, `GET /api/projects/:projectId/ai/disclosure` | `settings:read` / `settings:write` |
| Credentials | `/api/projects/:projectId/api-keys/*` (revealing the service key is a write), `/api/projects/:id/db-password`, the read-only and extra database roles | `secrets:read` / `secrets:write` |
| Database objects | `/api/projects/:projectId/database/*` (indexes, triggers, functions, extensions, row-level security policies), `/api/projects/:id/ensure-rls-bootstrap`, `/api/projects/:id/rls-diagnose` | `schema:read` / `schema:write` |
| Data import | `/api/projects/:projectId/data-imports/*` | `data:read` / `data:write` |
| Exports, backups, recovery | `/api/projects/:id/export*`, `/api/projects/:id/backups*`, `/api/projects/:id/pitr/*` | `backups:read` / `backups:write` |
| Activity | `GET /api/projects/:id/activity` | `logs:read` |
| Embeddings | `/api/projects/:projectId/embeddings/*` | `embeddings:read` / `embeddings:write` |
| Realtime | `/api/projects/:projectId/realtime-bindings*` | `realtime:read` / `realtime:write` |
| Integrations | `/api/projects/:projectId/integrations/*`, `/api/team-integrations/:teamId/*` | `integrations:read` / `integrations:write` |
| Sheet to App | `/api/blueprints*`, `/api/migrations/:runId*` | `blueprints:read` / `blueprints:write` |
| Teams | `GET /api/teams`, `/api/teams/:id` (rename), members, roles, invitations, role and security settings (read) | `team:read` / `team:write` |
| Billing | `GET /api/billing/subscription`, `usage`, `project-costs`, `invoices`, `invoices/:invoiceId/pdf`, `account`, `payment-method` | `billing:read` |
| Notifications | `/api/notifications*` | `account:read` / `account:write` |
| Feedback | `GET /api/feedback`, `PATCH /api/feedback/:id`, comments and history | `feedback:read` / `feedback:write` |

The route-by-route list with each route's scope is in
[reference/project-admin-api.md](./project-admin-api.md) for the project routes.

**Dashboard session only (a token gets 403):**

| What | Why |
|---|---|
| `/api/account/api-tokens/*` | a token never creates, lists, rolls or revokes tokens |
| `/api/auth/*`, `/api/organizations/*` | your identity, sign-in, MFA and organization structure |
| every billing change: checkout, portal, payment methods, plan changes, cancel, resume, billing account edits | money moves only from a signed-in person; `billing:write` is kept in the catalogue but no route accepts it |
| creating, deleting or leaving a team; transferring ownership; changing a team's security or role permissions; answering an invitation; the active team | ownership, security policy and membership decisions stay with the person |
| `POST /api/projects/:id/move-to-team` | moving a project between teams is an ownership decision |
| the platform operator console (`/api/admin/*`, `/api/observability/*`, `/api/billing/management/*`, `GET /api/projects/deletion-reasons`, status page administration, off-site backup reconcile) | operator actions are never automated with a personal token |
| the dashboard assistant, search, suggestions and event stream (`/api/ai/*`, `/api/search`, `/api/recommendations/*`, `/api/realtime/stream`) | dashboard features, not management API |

**Project data plane:** tables, rows, collections, storage, SQL, flows, RAG, agents, the data
engine and project users take a dashboard session or a **project key**, not an API token. Use the
project's service key there (see [docs/README.md](../README.md)); the **MCP server** covers the
SQL, schema, data, storage and auth reads an agent needs with a token.

### Team restriction

A token created for one team stays in that team. Any project or team the request names — a
`:projectId` or `/projects/:id` path, a `/teams/:id` or `:teamId` path, or `teamId` / `projectId`
in the query or body — must belong to the token's team, otherwise the answer is **403**
`This API token is limited to another team.` Routes that reach a team indirectly (a folder,
blueprint, invitation or job id) are confined the same way: while the request runs, the token's
owner counts as a member of the token's team only, so lists show only that team and anything in
another team answers as it would for a non-member (403 or 404). A token without a team
restriction reaches every team its owner belongs to, and no more.

Account-level routes that are not about a team (`/api/notifications`, `/api/feedback`) are not
narrowed by the team restriction.

The **MCP server** (`POST /api/mcp`) takes tokens only, and its tools need the scopes
`team:read`, `projects:read`, `schema:read`, `data:read`, `data:write`, `sql:read`, `sql:run`,
`storage:read` and `auth:read`; see [reference/mcp.md](./mcp.md). It enforces the
team restriction the same way.

## Using a token

Send it as a **Bearer** token to the management API base `https://api.basefyio.com/api`:

```bash
Authorization: Bearer bf_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

### Examples

```bash
TOKEN=bf_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
BASE=https://api.basefyio.com/api

# Which entities broadcast realtime events   (scope: realtime:read)
curl -s $BASE/projects/<PROJECT_ID>/realtime-bindings \
  -H "Authorization: Bearer $TOKEN"

# Enable realtime on a table                 (scope: realtime:write)
curl -s -X PUT $BASE/projects/<PROJECT_ID>/realtime-bindings \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"table","entity":"orders","enabled":true}'
```

### From an agent (Node/TypeScript)

```ts
const BASE = 'https://api.basefyio.com/api';
const headers = {
  Authorization: `Bearer ${process.env.BASEFYIO_API_TOKEN}`,
  'Content-Type': 'application/json',
};

// which entities broadcast
const bindings = await (
  await fetch(`${BASE}/projects/${process.env.PROJECT_ID}/realtime-bindings`, { headers })
).json();

// turn realtime on for a table
await fetch(`${BASE}/projects/${process.env.PROJECT_ID}/realtime-bindings`, {
  method: 'PUT', headers,
  body: JSON.stringify({ kind: 'table', entity: 'orders', enabled: true }),
});
console.log(bindings);
```

To run SQL from automation, use the project's service key against `POST /api/sql/execute`
with `{ "projectId": "<PROJECT_ID>", "query": "select count(*) from orders" }` — see
[docs/reference/sql-api.md](./sql-api.md).

The token acts **as you**, limited to its scopes and (if set) its team. It can only
reach projects in teams you belong to — cross-tenant access is not possible — and a token with a
team restriction only that team's projects.

## Managing tokens

- **List** — Account → API Tokens shows each token's name, scopes, team, **last used**,
  created date and status. The secret is never shown again.
- **Roll** — generates a new secret and invalidates the old one (use if a token leaked).
- **Revoke** — disables the token immediately; requests with it then return `401`.
- **Expiry** — an expired token returns `401`; create a new one to continue.

### Managing tokens over the API

The same operations are available to a dashboard session (a Keycloak JWT). A token cannot be used
to create or manage tokens — these routes answer `403` to a `bf_pat_…` bearer.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/account/api-tokens/scopes` | the scope catalogue, grouped as in the table above |
| GET | `/api/account/api-tokens` | your tokens (never the secret) |
| POST | `/api/account/api-tokens` | `{ name, scopes, teamId?, expiresAt? }` — create; the answer carries `token`, shown this once |
| PATCH | `/api/account/api-tokens/:id` | `{ name?, scopes?, expiresAt? }` — rename, change scopes or expiry |
| POST | `/api/account/api-tokens/:id/roll` | new secret, old one invalid; the answer carries the new `token` |
| DELETE | `/api/account/api-tokens/:id` | revoke → `{ revoked: true }` |

`scopes` must name at least one scope from the catalogue (400 `unknown scope: …` otherwise) and
`expiresAt` must be an ISO timestamp in the future; on `PATCH`, `expiresAt: null` removes the
expiry. A `teamId` you are not a member of is 403.

## Security best practices

- **Least privilege:** grant only the scopes the task needs (e.g. `sql:run` alone for
  a query agent). Avoid write scopes for read-only automation.
- **Keep it secret:** store tokens in your agent's/CI's secret store or an env var —
  never commit them or paste them in logs. basefyio never logs token values.
- **Short-lived:** set an expiry for automation and rotate regularly.
- **One token per use:** separate tokens per agent/integration so you can revoke one
  without affecting the others, and see each one's `last used`.
- **Revoke on suspicion:** if a token may have leaked, **roll** or **revoke** it at once.

## Errors

| Code | Meaning |
|---|---|
| `401` | Missing / invalid / revoked / expired token |
| `403` | The token is valid but lacks the required scope, the route does not accept tokens, or the target belongs to a team the token is not limited to |
| `404` | The resource (e.g. project) isn't in a team you belong to |

## API tokens vs. the Codefyio adapter

If you're driving basefyio from the **Codefyio IDE**, use its
[adapter](../integrations/codefyio-adapter.md) instead. The adapter's `/_codefyio/auth/exchange`
takes a token issued by Codefyio (`codefyioToken`) and mints its own short-lived
session; it does not take a `bf_pat_…` token.

Part of the basefyio documentation — index: [README.md](../README.md).
