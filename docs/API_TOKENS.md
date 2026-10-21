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
| `billing:read` / `billing:write` | read plan, subscription, usage, invoices · change plan, manage the subscription |
| `projects:read` / `projects:write` | list/inspect · create, rename, deactivate, restore, delete |
| `settings:read` / `settings:write` | project settings, folders and tags |
| `data:read` / `data:write` | read rows and documents · insert, update, delete |
| `schema:write` | create/alter/drop tables, collections and objects |
| `sql:run` | run SQL against a project database |
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

## Where a token is accepted today

A token is honoured only by routes guarded with `JwtOrPlatformTokenGuard`
(`apps/platform-api/src/modules/api-tokens/jwt-or-platform-token.guard.ts`); the
scope check is `ScopesGuard` on the same route. Every other management route is
guarded by the dashboard's Keycloak JWT alone and answers **401** to a token. As of
this writing the token-enabled surface is:

| Method | Path | Scope | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/realtime-bindings` | `realtime:read` | list which tables/collections broadcast |
| PUT | `/api/projects/:projectId/realtime-bindings` | `realtime:write` | enable/disable one entity |
| GET | `/api/projects/:id/backups/health` | `backups:read` | off-site copy state and the latest restore verifications |
| GET | `/api/projects/:id/backups/verifications` | `backups:read` | restore-verification history |
| POST | `/api/projects/:id/backups/verify` | `backups:write` | restore the newest nightly backup into a throwaway database now |
| GET | `/api/projects/:id/branches` | `projects:read` | list the project's preview branches |
| POST | `/api/projects/:id/branches` | `projects:write` | create a preview branch |
| DELETE | `/api/projects/:id/branches/:branchId` | `projects:write` | move a preview branch to the trash |

`POST /api/projects/backups/offsite/reconcile` sits behind the same guard without a scope; it is
restricted to platform operators, so a token answers 403 there unless its owner is one.
The routes are described in [reference/project-admin-api.md](./reference/project-admin-api.md).

The scope catalogue above is wider than that surface on purpose: scope strings are
stable and tokens store them verbatim, so a token created today keeps working as
routes adopt the guard. For everything else, use a **project key**: the service key
for a project's own data plane (`/api/rest/v1`, `/api/sql/execute`,
`/api/projects/:id/storage`, …), as documented in [docs/README.md](./README.md).

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
[docs/reference/sql-api.md](./reference/sql-api.md).

The token acts **as you**, limited to its scopes and (if set) its team. It can only
reach projects in teams you belong to — cross-tenant access is not possible.

## Managing tokens

- **List** — Account → API Tokens shows each token's name, scopes, team, **last used**,
  created date and status. The secret is never shown again.
- **Roll** — generates a new secret and invalidates the old one (use if a token leaked).
- **Revoke** — disables the token immediately; requests with it then return `401`.
- **Expiry** — an expired token returns `401`; create a new one to continue.

### Managing tokens over the API

The same operations are available to a dashboard session (a Keycloak JWT). A token cannot be used
to create or manage tokens — these routes answer `401` to a `bf_pat_…` bearer.

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
| `403` | The token is valid but lacks the required scope for this call |
| `404` | The resource (e.g. project) isn't in a team you belong to |

## API tokens vs. the Codefyio adapter

If you're driving basefyio from the **Codefyio IDE**, use its
[adapter](./CODEFYIO_ADAPTER.md) instead. The adapter's `/_codefyio/auth/exchange`
takes a token issued by Codefyio (`codefyioToken`) and mints its own short-lived
session; it does not take a `bf_pat_…` token.

Part of the basefyio documentation — index: [README.md](./README.md).
