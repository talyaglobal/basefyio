# SQL API

`POST /api/sql/execute` runs one SQL statement (or a batch separated by `;`) against a
project's database and returns the rows. It is the route the JavaScript SDK's `from()`
query builder and `sql()` use, and the route the dashboard SQL editor uses.

## Authentication

| Credential | How the statement runs |
|---|---|
| service key (`apikey`) | as the Postgres role `service_role`, which bypasses row-level security |
| anon key (`apikey`) | as `anon`: reads only what policies allow; the default grants give it `SELECT` on tables and nothing else |
| anon key + `Authorization: Bearer <end-user token>` | as `authenticated`, with the user's claims available to policies through `auth.uid()`, `auth.jwt()`, `auth.email()` |
| dashboard session (Bearer Keycloak JWT, no `apikey`) | as the project's owner database user — the SQL editor path; DDL is allowed |

The guard decides which of the two is in play by the headers: a `Bearer` token is tried
first as a dashboard session; an `apikey` header is tried as a project key.

## Request

```
POST /api/sql/execute
Content-Type: application/json
apikey: <key>            (or Authorization: Bearer <dashboard JWT>)
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `projectId` | uuid | yes | the project whose database runs the statement; must be the key's project |
| `query` | string | yes | the SQL text; `$1 … $n` placeholders refer to `params` |
| `params` | array | no | bound values for the placeholders, at most 65 535 |
| `page` | integer ≥ 1 | no | page of a paginated `SELECT`; default 1 |
| `limit` | integer 1–1000 | no | page size; default 100 |
| `countTotal` | boolean | no | also count the full result (capped at 10 001 rows) |

**Always pass values as `params`, never inline.** The guard scans the whole statement —
string literals included, because a literal is where a smuggled `COPY` would hide — so an
ordinary value such as `"grant access"` written into the SQL is refused as the operation it
names. A bound value is never scanned as SQL and can never become syntax.

## Response

```json
{
  "rows": [ { "id": 1, "title": "Buy milk" } ],
  "fields": [ { "name": "id", "dataTypeId": 20 }, { "name": "title", "dataTypeId": 25 } ],
  "rowCount": 1,
  "page": 1,
  "limit": 100
}
```

`rowCount` is the number of rows returned (for `SELECT`) or affected (for writes). With
`countTotal: true` the response also carries the total of the unpaginated result. A `SELECT`
is wrapped as `SELECT * FROM (<your query>) AS _bf_paged LIMIT <limit> OFFSET <offset>`;
non-`SELECT` statements are run as written.

## Limits

- Statement timeout: 30 seconds (`statement_timeout` on the connection).
- Page size: at most 1000 rows per call.
- Every execution is written to the audit log with the caller, duration and row count, and
  appears in the project's activity timeline in the dashboard.

## Statements that are refused

Two lists live in `apps/platform-api/src/modules/sql/sql-guard.ts`. Comments are stripped
before matching, so a token hidden in `/* … */` or after `--` is still found.

**Refused for every caller** (`FORBIDDEN_PATTERNS`): `DROP DATABASE`, `DROP ROLE`,
`CREATE ROLE`, `ALTER ROLE`, `CREATE DATABASE`, `COPY `, `pg_read_file`, `pg_write_file`,
`pg_read_binary_file`, `pg_ls_dir`, `pg_stat_file`, `lo_import`, `lo_export`,
`CREATE EXTENSION`, `LOAD `, `SET ROLE`, `SET SESSION AUTHORIZATION`, `GRANT `, `REVOKE `,
`CREATE USER`, `ALTER USER`, `DROP USER`, `CREATE TABLESPACE`, `ALTER SYSTEM`,
`PG_READ_SERVER_FILES`, `PG_WRITE_SERVER_FILES`, `PG_EXECUTE_SERVER_PROGRAM`, `DBLINK`,
`CREATE FOREIGN`, `CREATE SERVER`, `CREATE PUBLICATION`, `CREATE SUBSCRIPTION`.

**Refused unless the caller is the owner (dashboard session) or the service key**
(`OWNER_ONLY_PATTERNS`): `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `TRUNCATE`,
`CREATE SCHEMA`, `DROP SCHEMA`, `ALTER SCHEMA`, `CREATE INDEX`, `DROP INDEX`, `CREATE VIEW`,
`ALTER VIEW`, `DROP VIEW`, `CREATE MATERIALIZED VIEW`, `CREATE POLICY`, `ALTER POLICY`,
`DROP POLICY`, `ROW LEVEL SECURITY`, `CREATE FUNCTION`, `CREATE OR REPLACE FUNCTION`,
`DROP FUNCTION`, `CREATE PROCEDURE`, `CREATE TRIGGER`, `DROP TRIGGER`, `CREATE SEQUENCE`,
`ALTER SEQUENCE`, `CREATE TYPE`, `DROP TYPE`, `SECURITY DEFINER`.

The second list exists so that a public anon key can never take the lid off the mechanism
that bounds it (disable RLS, rewrite a policy, or define a `SECURITY DEFINER` function and
call it back through `rpc`). Postgres grants already prevent most of this; the guard is the
second layer.

Extensions are not created through SQL on any path; use the dashboard's Database → Extensions
page or `PUT /api/projects/:projectId/database/extensions` (see
[project-admin-api.md](./project-admin-api.md)).

## Examples

Read with the anon key as a signed-in user (RLS applies):

```bash
curl -s https://api.basefyio.com/api/sql/execute \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"'$PROJECT_ID'","query":"select id, title from todos where done = $1 order by created_at desc","params":[false],"limit":50}'
```

Administrative write from your server with the service key:

```bash
curl -s https://api.basefyio.com/api/sql/execute \
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \
  -d '{"projectId":"'$PROJECT_ID'","query":"update orders set status = $1 where id = $2","params":["shipped", 42]}'
```

With the SDK (`from()` compiles to SQL and posts it here; `sql()` sends your text):

```ts
const { data } = await bf.from('todos').select('id,title').eq('done', false).order('created_at', { ascending: false }).limit(50);
const { data: rows } = await bf.sql('select count(*)::int as n from todos where user_id = $1', [userId]);
```

## Errors

| Status | When |
|---|---|
| 400 | validation (`projectId` not a uuid, `limit` out of range, unknown body property); a refused statement — the message names the pattern, e.g. `Forbidden SQL pattern: CREATE POLICY`; a Postgres error in your SQL (message is the database's) |
| 401 | missing or invalid key / token |
| 403 | the key belongs to another project; anon key on a statement it may not run |
| 404 | project not found or not active |
| 500 | the statement failed for a reason the server does not expose; check the SQL in the dashboard editor |

Source: `apps/platform-api/src/modules/sql/sql.controller.ts`, `sql.service.ts`,
`sql-guard.ts`, `dto/execute-sql.dto.ts`; SDK: `packages/sdk/src/modules/database.ts`.
