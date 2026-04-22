# Row Level Security (RLS)

> Security model and policy-authoring guide for Kolaybase project databases.

Last updated: 2026-04-22

## Table of Contents

- [Overview](#overview)
- [Threat Model](#threat-model)
- [Mechanism](#mechanism)
- [Role Matrix](#role-matrix)
- [Request Flow](#request-flow)
- [Why FORCE ROW LEVEL SECURITY Is Not Required](#why-force-row-level-security-is-not-required)
- [auth.* Helpers](#auth-helpers)
- [Writing Policies](#writing-policies)
- [Operational Tasks](#operational-tasks)
- [Verifying Bootstrap](#verifying-bootstrap)
- [Known Limitations](#known-limitations)
- [See Also](#see-also)

## Overview

Every Kolaybase project database is bootstrapped to behave like Supabase's RLS surface: three dedicated Postgres roles (`anon`, `authenticated`, `service_role`), an `auth` schema with `uid() / jwt() / role() / email()` helpers, and a per-request role switch that pipes the caller's JWT claims into the session so policies can read them.

RLS enforcement happens at the database layer. The platform API is not trusted to filter rows by user; Postgres is. That means a correctly-written policy protects the data even if the API has a bug that leaks a record set.

## Threat Model

Who the system defends against, and how:

| Adversary                                         | Control                                                              |
|---------------------------------------------------|----------------------------------------------------------------------|
| Client using the anon key only                    | Connects as `anon` (no `BYPASSRLS`); policies gate everything.       |
| Client using anon key + forged JWT                | JWT signature verified against the project's Keycloak realm JWKS.     |
| Client using anon key + legitimate user JWT       | Connects as `authenticated`; `auth.uid()` is the verified `sub`.     |
| Client with leaked service key                    | Connects as `service_role` (`BYPASSRLS`). Service keys must be treated as root. |
| Buggy policy that returns too many rows           | Defense in depth: API-level filters still apply; audit logs capture it. |
| Direct Postgres access as `kb_user_<slug>`        | Owner bypasses RLS. Compromise of the owner credential == full data access (expected). |

The service role key is equivalent to a Postgres superuser for that project. Never embed it in a browser, mobile app, or untrusted client.

## Mechanism

Each ACTIVE project database contains:

1. **Three login-less roles**
   - `anon` — default surface for unauthenticated callers
   - `authenticated` — surface for JWT-bearing callers
   - `service_role` — `BYPASSRLS`, used for server-to-server and admin work
2. **Schema `auth`** owned by the project's DB user, with four STABLE functions: `jwt()`, `uid()`, `role()`, `email()`.
3. **Default privileges** configured so tables created by the project owner are automatically selectable by `authenticated` / `service_role` (and `SELECT` only for `anon`). Existing tables get the same grants applied by the bootstrap.
4. **Column `projects.rls_bootstrapped_at`** in the control-plane DB — a timestamp that proves the project DB has been seeded.

The seeding SQL lives in `apps/platform-api/src/modules/projects/sql/rls-bootstrap.sql` and is idempotent, so re-running it is safe.

## Role Matrix

| Role             | `rolbypassrls` | Default SELECT | Default INSERT/UPDATE/DELETE | Typical caller                                 |
|------------------|----------------|----------------|------------------------------|------------------------------------------------|
| `anon`           | false          | via policy     | via policy (usually denied)  | Public traffic hitting `/rest/v1/...` with only anon key |
| `authenticated`  | false          | via policy     | via policy                   | User-logged-in traffic: anon key + Bearer JWT   |
| `service_role`   | **true**       | all rows       | all rows                     | Trusted server code with the service key        |
| `kb_user_<slug>` | false          | as table owner | as table owner               | Project owner; RLS skipped for owned tables by default (only reachable with DB admin credentials) |

`anon` and `authenticated` **are not superusers**. Without a policy that allows an action, that action is blocked.

## Request Flow

```
┌──────────┐     apikey + optional Bearer JWT      ┌────────────────┐
│  Client  │ ─────────────────────────────────────▶ │ ApiKeyGuard    │
└──────────┘                                        │ (platform-api) │
                                                    └──────┬─────────┘
                                                           │ resolves
                                                           │  - projectId
                                                           │  - dbRole (anon|authenticated|service_role)
                                                           │  - jwtClaims (verified)
                                                           ▼
                                                  ┌────────────────────┐
                                                  │ PublicApiService   │
                                                  │ .withRls()         │
                                                  └─────────┬──────────┘
                                                            │
  BEGIN;                                                    │
  SET LOCAL ROLE <dbRole>;                                  │
  SELECT set_config('request.jwt.claims', '<json>', true);  │
  SELECT set_config('request.jwt.role', '<dbRole>', true);  │
  <user query runs here>                                    │
  COMMIT;                                                   ▼
                                                  ┌────────────────────┐
                                                  │ Project Postgres   │
                                                  │  (RLS applies)     │
                                                  └────────────────────┘
```

Rules the guard follows:

| `apikey` header | `Authorization: Bearer <jwt>` | Effective role   |
|-----------------|-------------------------------|------------------|
| service key     | any (ignored)                 | `service_role`   |
| anon key        | absent                        | `anon`           |
| anon key        | valid, signed by project realm| `authenticated`  |
| anon key        | present but invalid/forged    | request rejected |

Because the service role always bypasses RLS, we intentionally ignore any Bearer token sent alongside it — there is no useful "signed-in service role" state.

## Why FORCE ROW LEVEL SECURITY Is Not Required

Postgres skips RLS when the session's current user is the table owner. That is why naive single-user setups need `ALTER TABLE ... FORCE ROW LEVEL SECURITY`: otherwise the application user is the owner, RLS is bypassed, and the policies are decorative.

Kolaybase avoids this trap by separating *connection identity* from *effective identity*:

- The connection logs in as the table owner (`kb_user_<slug>`) because only the owner can create tables, manage schema, and run migrations.
- Immediately after `BEGIN`, the session runs `SET LOCAL ROLE anon | authenticated | service_role`. From that point on, the session's effective user is one of the non-owner roles.
- RLS applies to non-owners. Policies on `anon` and `authenticated` are enforced.
- `SET LOCAL ROLE` is scoped to the transaction, so the connection returns to the owner identity on `COMMIT` / `ROLLBACK` and the connection can be pooled safely.

`FORCE ROW LEVEL SECURITY` is still useful in two niche cases:

1. Tables that should block even their owner — usually audit logs or compliance tables. Add `FORCE` per-table.
2. Admin ops that run as the owner but should still obey policies. Kolaybase's public API never does this, but a migration script might.

If you do add `FORCE`, write a policy that explicitly re-allows the owner, otherwise your migrations will start failing. Example:

```sql
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_owner ON audit_log FOR ALL TO "kb_user_myproj" USING (true) WITH CHECK (true);
```

## auth.* Helpers

All four helpers read from the `request.jwt.claims` setting that `withRls()` injects before the user's query runs. They are `STABLE`, so Postgres can inline them into policy predicates and use indexes.

| Function         | Returns | Source                                       |
|------------------|---------|----------------------------------------------|
| `auth.jwt()`     | `jsonb` | `current_setting('request.jwt.claims', true)::jsonb` (falls back to `'{}'::jsonb`) |
| `auth.uid()`     | `text`  | `auth.jwt() ->> 'sub'`                        |
| `auth.role()`    | `text`  | `request.jwt.role` first, then `auth.jwt() ->> 'role'`, then `'anon'` |
| `auth.email()`   | `text`  | `auth.jwt() ->> 'email'`                      |

Example: querying them in-session for debugging:

```sql
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"7af3...","role":"authenticated","email":"a@b.c"}', true);
SELECT auth.uid(), auth.role(), auth.email(), auth.jwt();
ROLLBACK;
```

## Writing Policies

The default for an RLS-enabled table is deny-everything. A table without policies is unreadable by `anon` / `authenticated`.

Minimal pattern: owner-scoped rows.

```sql
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY todos_select_own ON public.todos
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY todos_write_own ON public.todos
  FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());
```

Public-read, owner-write:

```sql
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY posts_public_read ON public.posts
  FOR SELECT TO anon, authenticated
  USING (published = true);

CREATE POLICY posts_author_write ON public.posts
  FOR ALL TO authenticated
  USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());
```

Team-scoped rows (JWT custom claim):

```sql
-- JWT is expected to carry a "team_id" custom claim.
CREATE POLICY invoices_team ON public.invoices
  FOR SELECT TO authenticated
  USING (team_id = (auth.jwt() ->> 'team_id'));
```

Role-gated admin writes (JWT `realm_access.roles` claim from Keycloak):

```sql
CREATE POLICY settings_admin_update ON public.settings
  FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'realm_access' -> 'roles') ? 'admin')
  WITH CHECK ((auth.jwt() -> 'realm_access' -> 'roles') ? 'admin');
```

### Policy authoring checklist

- `ENABLE ROW LEVEL SECURITY` on the table, otherwise policies are inert.
- Separate `FOR SELECT` from write policies; use `FOR ALL` only when the predicate is identical.
- Always set `WITH CHECK` on write policies, or an `authenticated` caller can insert rows they could not read back.
- Remember `anon` is a role you can target too. Omitting it effectively denies anon.
- Use `auth.uid()` / `auth.jwt()` inside the predicate — they are `STABLE` and work with indexes like `CREATE INDEX ... ON (owner_id)`.

## Operational Tasks

### Fresh project

Nothing to do. `ProjectsService.create()` runs `applyRlsBootstrap()` after creating the owner role, which applies the SQL template and stamps `projects.rls_bootstrapped_at`.

### Existing projects (backfill)

```sh
# From apps/platform-api:
npm run rls:backfill:dry   # list what would run
npm run rls:backfill       # actually apply
```

The script reads ACTIVE projects from the control-plane DB, skips anything with `rls_bootstrapped_at` set (use `--force` to reapply), and only operates on shared-host DBs (dedicated-host projects require running the script from that host or extending it).

### Re-applying after schema drift

The bootstrap is idempotent, so it is safe to rerun at any time, e.g. after Postgres upgrades or when adding new claim-reading helpers to `auth`:

```sh
npm run rls:backfill -- --force
```

### Granting access on newly-created tables

`rls-bootstrap.sql` sets `ALTER DEFAULT PRIVILEGES` for tables created by the project owner, so anything created by migrations or by the SQL editor (which runs as the owner) inherits the right grants. No manual `GRANT` is needed.

If you create a table with a different owner (unlikely), you must grant manually:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON public.my_table TO authenticated, service_role;
GRANT SELECT ON public.my_table TO anon;
```

## Verifying Bootstrap

Connect to the project DB as the project owner (Admin UI → Connect, or via pgbouncer with the owner credential) and run:

```sql
-- Roles present with the right BYPASSRLS flags
SELECT rolname, rolbypassrls
FROM pg_roles
WHERE rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY rolname;
-- Expected:
--   anon           | f
--   authenticated  | f
--   service_role   | t

-- auth schema present
\dn auth

-- auth helpers present
\df auth.*

-- Control-plane stamp present
-- (run this against the control-plane `kolaybase` DB)
SELECT slug, rls_bootstrapped_at
FROM projects
WHERE status = 'ACTIVE'
ORDER BY slug;
```

End-to-end proof that RLS fires for non-owner roles:

```sql
CREATE TABLE rls_probe (id int, owner text);
ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY;
INSERT INTO rls_probe VALUES (1, 'alice'), (2, 'bob');
CREATE POLICY p_own ON rls_probe FOR SELECT TO authenticated
  USING (owner = auth.uid());

BEGIN;
  SET LOCAL ROLE authenticated;
  SELECT set_config('request.jwt.claims',
    '{"sub":"alice","role":"authenticated"}', true);
  SELECT * FROM rls_probe;    -- only (1, 'alice')
ROLLBACK;

BEGIN;
  SET LOCAL ROLE service_role;
  SELECT * FROM rls_probe;    -- all rows (BYPASSRLS)
ROLLBACK;

DROP TABLE rls_probe;
```

If the `authenticated` block returned both rows, RLS did *not* fire — check that the table had `ENABLE ROW LEVEL SECURITY`, that `SET LOCAL ROLE` succeeded (look for permission errors), and that the caller wasn't silently using the owner role (which bypasses RLS on its own tables).

## Known Limitations

- **Custom JWT claims must match policy expectations.** Kolaybase's SDK mints tokens via the project's Keycloak realm. If you write a policy against `auth.jwt() ->> 'team_id'`, that claim must be present on every token. Configure it as a Keycloak client mapper.
- **RLS does not protect the SQL editor or migrations.** Both run as the project owner, which bypasses policies by design. Treat `/sql` access and migration credentials as admin-level.
- **Pooling and `SET LOCAL`.** `SET LOCAL` is bounded by the transaction, which matches the pool lifecycle safely. Never use `SET ROLE` (session-scoped) in a pooled connection — it would leak between requests.
- **Indexes on claim columns.** Policies that filter by `auth.uid()` are only fast if the underlying column has an index. `CREATE INDEX ON todos (owner_id);` is almost always worth doing.
- **Dedicated-host projects.** The backfill script only handles shared-host DBs. For dedicated-host deployments, run the same bootstrap SQL from the host with its own credentials.

## See Also

- `apps/platform-api/src/modules/projects/sql/rls-bootstrap.sql` — the seeding template
- `apps/platform-api/src/modules/projects/public-api.service.ts` — `withRls()` transaction wrapper
- `apps/platform-api/src/common/guards/api-key.guard.ts` — apikey + JWT → role resolution
- `apps/platform-api/scripts/backfill-rls.ts` — one-shot backfill utility
- [`architecture.md`](./architecture.md) — overall control-plane / data-plane split
