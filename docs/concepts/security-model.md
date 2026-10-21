# Security model: keys, roles and row-level security

How a request to a basefyio project is identified, which database role it runs as, and how
row-level security (RLS) in the project's own PostgreSQL database decides what it may see.

## Two kinds of credential

| Credential | Who holds it | Authenticates | Reference |
|---|---|---|---|
| **Project keys** — `anon` and `service_role` | your application | the data API of one project: `/api/rest/v1/*`, `/api/sql/execute`, `/api/realtime/v1/*`, `/api/projects/:id/storage/*`, and the service-key administration routes | this page |
| **Dashboard session** — a Keycloak JWT of the platform realm | a person signed in to the dashboard | the platform API: projects, teams, billing, database administration | — |
| **API token** — `bf_pat_…` | an automation acting as a person | the management routes that declare `JwtOrPlatformTokenGuard`, limited by scopes | [../API_TOKENS.md](../API_TOKENS.md) |

A project key identifies exactly one project. The guard compares the key with every place a
request names a project — path, body and query — and refuses a key used against another
project (403 `This API key does not belong to the requested project`).

## The anon key is public

It ships inside your browser bundle; anyone who opens the network tab has it. Everything the
anon key can reach is therefore reachable by the whole internet, and the platform is built on
that assumption:

- The anon key may travel in a URL (`?apikey=`) on the routes a browser opens without
  headers — the realtime stream and e-mail links. The **service key is refused in a URL**
  (401), because URLs end up in logs, history and `Referer` headers.
- Routes declare how much authority they need with three decorators. `@ServiceKeyOnly()`
  refuses the anon key outright; `@AuthenticatedKeyOnly()` requires the anon key to come with
  a verified end-user token; `@AnonKeyAllowed()` is the explicit carve-out. A controller can be
  marked service-only as a whole, so a route added to it later is closed until someone states
  otherwise — forgetting a guard cannot open a hole. The check runs inside the key guard
  itself on every exit path.
- The service key bypasses RLS, so it is only ever used from your own server. If it leaks,
  rotate it from the project's Connection page.

## From key to database role

Every statement a project key triggers runs inside a transaction that first switches the
Postgres role and publishes the caller's claims:

| Request | Role (`SET LOCAL ROLE`) | `request.jwt.claims` |
|---|---|---|
| anon key | `anon` | empty |
| anon key + `Authorization: Bearer <end-user JWT>` | `authenticated` | the verified JWT payload |
| service key | `service_role` (`BYPASSRLS`) | empty |
| dashboard session on `/api/sql/execute` | the project's owner login role — no role switch, no RLS | — |

The end-user token is **verified**, not merely decoded: its signature is checked against the
project realm's JWKS and its issuer against the realm. A token that does not verify is
refused with 401 rather than demoted to anon — otherwise a forged `sub` could pick which
rows a policy returns. A Bearer value that is just the project key itself is treated as anon,
because many clients mirror the key into `Authorization`.

Every project database is provisioned with the roles `anon`, `authenticated` and
`service_role` (all `NOLOGIN NOINHERIT`), granted to the owner login role so it can switch to
them, an `auth` schema, and these helper functions
(`apps/platform-api/src/modules/projects/sql/rls-bootstrap.sql`):

| Function | Returns | Definition |
|---|---|---|
| `auth.jwt()` | `jsonb` | `current_setting('request.jwt.claims', true)::jsonb`, `{}` when absent |
| `auth.uid()` | `text` | `auth.jwt() ->> 'sub'` — the end user's id |
| `auth.role()` | `text` | `request.jwt.role`, else the `role` claim, else `'anon'` |
| `auth.email()` | `text` | `auth.jwt() ->> 'email'` |

Anonymous sessions (`POST /api/rest/v1/auth/signin/anonymous`) carry `is_anonymous: true` in
the token: `coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)` tells them apart.

## Default grants — and why a table without RLS is public

When the owner creates a table, default privileges apply:

- `anon`: `SELECT` on every table and `USAGE` on the schema;
- `authenticated` and `service_role`: `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES,
  TRIGGER` on tables, `USAGE, SELECT, UPDATE` on sequences;
- all three: `EXECUTE` on functions.

So a table **without** `ENABLE ROW LEVEL SECURITY` is readable by anyone holding the anon key
and writable by any signed-in user. RLS is what narrows that:

```sql
alter table todos enable row level security;

create policy "todos owner select" on todos for select to authenticated
  using (user_id = auth.uid());
create policy "todos owner insert" on todos for insert to authenticated
  with check (user_id = auth.uid());
create policy "todos owner update" on todos for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "todos owner delete" on todos for delete to authenticated
  using (user_id = auth.uid());
```

With these four policies and no policy for `anon`, the anon key sees nothing in `todos`, a
signed-in user sees and edits only their own rows, and the service key still sees everything.
`auth.uid()` returns `text`, so store the owner in a `text` column
(`user_id text not null default auth.uid()` fills it in automatically on insert).

Policies can be written in the SQL editor, or through the dashboard's Database → Policies
page, which uses `GET/POST/PUT/DELETE /api/projects/:projectId/database/policies` and
`POST /api/projects/:projectId/database/policies/rls` with a SQL preview and a dry run — see
[../reference/project-admin-api.md](../reference/project-admin-api.md).

## Where RLS applies

| Surface | Behaviour |
|---|---|
| `/api/rest/v1/:table`, `rpc` | role + claims per request; a `SECURITY DEFINER` function cannot be called with the anon key alone |
| `/api/rest/v1/collections` | same mechanism on the collection tables |
| `/api/sql/execute` with a key | role + claims; owner-only DDL verbs refused for anon/authenticated by the SQL guard |
| realtime stream | on a table with RLS, each subscriber receives only the rows its role may select; without RLS every subscriber receives every change ([../REALTIME_API.md](../REALTIME_API.md)) |
| storage | per bucket (public/private) plus access rules `public-read`, `authenticated-read`, `owner-only` per bucket or prefix ([../reference/storage-api.md](../reference/storage-api.md)) |
| embeddings / RAG | no row-level policy: writes need the service key, search needs a signed-in user, RAG search is service-only |

## The SQL guard

A second layer under the grants (`apps/platform-api/src/modules/sql/sql-guard.ts`): a fixed
denylist of statements nobody may run through the API (role, database, file and extension
operations) and a second list — DDL, policy verbs, `ROW LEVEL SECURITY`, `SECURITY DEFINER` —
refused unless the caller is the owner or the service key. Its purpose is to make sure a
public key can never take the lid off the mechanism that bounds it, even if a grant were ever
misapplied. Details in [../reference/sql-api.md](../reference/sql-api.md).

## Operational safeguards

- Project database credentials are encrypted at rest with `DB_CRED_ENC_KEY` (AES-256-GCM);
  without the key the platform refuses to store a credential rather than writing it in clear.
  Losing the key makes stored credentials unrecoverable.
- A read-only companion login (`<dbUser>_readonly`, `SELECT` on everything) can be created per
  project for BI tools; it is a database role, not an API key, and bypasses nothing RLS does
  not already allow the owner.
- Every key-authenticated request and every SQL statement reaches the audit log with the key's
  tier; the log can be forwarded to a SIEM (webhook or syslog) by the operator.
- Repairs: `POST /api/projects/:id/ensure-rls-bootstrap` re-applies the roles and helpers to an
  existing database; `GET /api/projects/:id/rls-diagnose` reports what is missing.

Two operator switches relax a refusal to log-only for a deployment that depends on the old
behaviour: `SERVICE_KEY_PROJECT_BINDING=log` (service key aimed at another project) and
`ANON_WRITE_BINDING=log` (bare anon key on a route that wants a signed-in user). The default
is to refuse.

Source: `apps/platform-api/src/common/guards/api-key.guard.ts`,
`common/decorators/api-key-scope.decorator.ts`, `modules/projects/sql/rls-bootstrap.sql`,
`modules/projects/public-api.service.ts`, `modules/sql/sql-guard.ts`,
`modules/projects/project-anonymous-auth.service.ts`, `common/crypto/field-crypto.ts`.
