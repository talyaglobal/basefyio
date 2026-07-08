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

Tokens are scoped Cloudflare-style as `resource:action`:

| Scope | Grants |
|---|---|
| `account:read` | read your profile & teams |
| `projects:read` / `projects:write` | list/inspect · create, rename, pause, restore, delete |
| `data:read` / `data:write` | list/read tables & collections · insert/update/delete rows |
| `sql:run` | run SQL against a project's database |
| `storage:read` / `storage:write` | list/download · upload/delete buckets & objects |
| `auth:read` / `auth:write` | list realm users/sessions · create/update/reset/repair |
| `realtime:read` / `realtime:write` | list bindings · enable/disable broadcasting |
| `flows:read` / `flows:write` | list · create/trigger automation flows |
| `blueprints:read` / `blueprints:write` | list · analyze/approve/generate (App Builder) |
| `billing:read` | read plan, subscription and invoices |

A **read** call needs the matching `:read` scope; a **write/mutating** call needs
`:write` (or `sql:run` for SQL). A request whose token lacks the scope returns **403**.

## Using a token

Send it as a **Bearer** token to the management API base `https://api.basefyio.com/api`:

```bash
Authorization: Bearer bf_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

### Examples

```bash
TOKEN=bf_pat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
BASE=https://api.basefyio.com/api

# List your projects        (scope: projects:read)
curl -s $BASE/projects -H "Authorization: Bearer $TOKEN"

# Run SQL on a project       (scope: sql:run)
curl -s -X POST $BASE/projects/<PROJECT_ID>/sql \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"select count(*) from orders"}'

# Enable realtime on a table (scope: realtime:write)
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

// discover projects
const projects = await (await fetch(`${BASE}/projects`, { headers })).json();

// run a query on the first one
const res = await fetch(`${BASE}/projects/${projects[0].id}/sql`, {
  method: 'POST', headers,
  body: JSON.stringify({ query: 'select now()' }),
});
console.log(await res.json());
```

The token acts **as you**, limited to its scopes and (if set) its team. It can only
reach projects in teams you belong to — cross-tenant access is not possible.

## Managing tokens

- **List** — Account → API Tokens shows each token's name, scopes, team, **last used**,
  created date and status. The secret is never shown again.
- **Roll** — generates a new secret and invalidates the old one (use if a token leaked).
- **Revoke** — disables the token immediately; requests with it then return `401`.
- **Expiry** — an expired token returns `401`; create a new one to continue.

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

If you're driving basefyio from the **Codefyio IDE**, you can use its
[adapter](./CODEFYIO_ADAPTER.md) instead — its auth-exchange also accepts an API
token, and the same scope rules apply.
