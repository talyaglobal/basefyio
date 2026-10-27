# Project administration API

The routes the dashboard and the CLI use to run a project: create and delete it, read its
connection details, manage tables and database objects, edit row-level security policies,
import data, take and restore backups, recover to a point in time and create preview branches.
Your application's own data traffic belongs on the data API ([rest-api.md](./rest-api.md),
[sql-api.md](./sql-api.md)); these routes act with the project owner's rights.

## Authentication

| Tier | Credential |
|---|---|
| `service` | the project's **service key** in the `apikey` header, or a dashboard session. The anon key is refused with 403. |
| `session` | a dashboard session (`Authorization: Bearer <Keycloak JWT>`) only. Keys and API tokens are refused with 401. |
| `session · token` | a dashboard session or an [API token](../API_TOKENS.md) (`bf_pat_…`) holding the scope named in the row. |
| `root` | a dashboard session of a platform operator (user role `ROOT`); every other account gets 403. |

Every project-scoped route also checks that the signed-in person is a member of the project's
team (403 `Not a member of this team`, or 404 `Project not found` where the service prefers not
to confirm the project exists). A few routes need more than membership; the *Who* notes below
say which.

The `service`-tier routes in [Tables, rows and foreign keys](#tables-rows-and-foreign-keys) and
`GET connect` run on a connection as the project's database **owner**: row-level security does
not apply to them. That is why the anon key can never reach them.

## Project lifecycle

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/projects` | session | create a project — `{ name, teamId, description?, databaseType? }` |
| GET | `/api/projects` | session | `?teamId=` — the team's active projects |
| GET | `/api/projects/deleted` | session | `?teamId=` — projects in the trash |
| GET | `/api/projects/deactivated` | session | `?teamId=` — deactivated projects |
| GET | `/api/projects/:id` | session | one project |
| PATCH | `/api/projects/:id` | session | `{ name?, description?, folderId?, tags? }` |
| GET | `/api/projects/:id/activity` | session | `?page=&limit=` — the project's activity log (limit 1–500, default 50) |
| PATCH | `/api/projects/:id/max-rows` | session | `{ maxRowsPerTable }` — page-size ceiling of the dashboard data grid |
| POST | `/api/projects/:id/move-to-team` | session | `{ teamId }` — move the project to another team |
| POST | `/api/projects/:id/deactivate` | session | freeze the project without deleting data |
| POST | `/api/projects/:id/reactivate` | session | bring a deactivated project back |
| DELETE | `/api/projects/:id` | session | move the project to the trash — optional body `{ reasonCode?, reasonLabel?, details? }` |
| POST | `/api/projects/:id/restore` | session | take a project out of the trash |
| DELETE | `/api/projects/:id/permanent` | session | permanently delete a project that is in the trash |
| GET | `/api/projects/deletion-reasons` | root | `?limit=` — recent deletions and the reasons given (at most 500) |

### Create

```
POST /api/projects
{ "name": "orders", "teamId": "<team id>", "description": "…", "databaseType": "RELATIONAL" }
```

`name` must not be blank and must be unique within the team (400 `A project with this name
already exists in this team`); keep it to 64 characters, as the dashboard does.
`databaseType` is `RELATIONAL` (default) or `NOSQL`. Creating a
project provisions its PostgreSQL database and database user, its identity realm, the
row-level-security roles, the default extensions and the read-only companion role (see
[Connection and credentials](#connection-and-credentials); an operator can switch the last two off
with `PROVISION_DEFAULT_EXTENSIONS` and `PROVISION_READONLY_ROLE`). A `NOSQL` project also gets its
document-store tenant. The plan's project quota is enforced. The response is the new project
record, including its `anonKey` and `serviceKey`.

### Trash, deactivation and permanent deletion

- `DELETE /api/projects/:id` renames the database and its user and disables the realm; nothing is
  erased. The project stays in the trash for 24 hours, then an hourly job removes it for good.
  Its preview branches go to the trash with it. Answer: `{ "message": "Project deleted" }`.
- `POST /api/projects/:id/restore` undoes that while the project is still in the trash. 403 when a
  live project in the team already uses the original name.
- `DELETE /api/projects/:id/permanent` starts the teardown of a trashed project in the background
  and answers at once with `{ "message": "Project deletion started", "status": "deleting" }`.
- `POST /api/projects/:id/deactivate` disables sign-in and data access but keeps every byte; a
  deactivated project does not count against the plan's project quota and is purged after 14 days
  unless reactivated. `reactivate` enforces the quota again.

*Who:* deleting and deactivating need the team owner or the project's creator; restoring and
permanent deletion also accept a team admin. Moving a project needs the owner of the source team
and membership in the target team.

### Row limit

`PATCH /api/projects/:id/max-rows` accepts `1000`, `10000` or `100000`; the plan sets the ceiling
(free 1 000, pro 10 000, business and enterprise 100 000) and a higher value is 403. Answer:
`{ maxRowsPerTable, planCeiling }`. It caps how many rows `GET …/tables/:tableName/rows` returns
per page; it does not limit how many rows a table can hold.

## Connection and credentials

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/connect` | service | connection strings, keys, read-only role and pooler limit |
| PATCH | `/api/projects/:id/db-password` | session | `{ password? }` — rotate the owner password (random when omitted) |
| POST | `/api/projects/:id/db-readonly-role` | session | create the read-only companion role, or repair its grants |
| PATCH | `/api/projects/:id/db-readonly-password` | session | `{ password? }` — rotate the read-only role's password |
| DELETE | `/api/projects/:id/db-readonly-role` | session | remove the read-only role |
| PATCH | `/api/projects/:id/db-connection-limit` | session | `{ maxDbConnections: number \| null }` — pooled connections allowed to this database |

*Who:* the four write routes need the team permission **reset database password** (team owners
always have it); others get 403 `Your role does not have the "canResetDbPassword" permission in
this team`.

### `GET connect`

```json
{
  "uri": "postgresql://<user>:<password>@<direct host>:<direct port>/<database>",
  "poolerUri": "postgresql://<user>:<password>@<pooler host>:6432/<database>",
  "host": "<pooler host>", "port": 5432, "database": "…", "user": "…", "password": "…",
  "poolerHost": "<pooler host>", "poolerPort": 6432,
  "restUrl": "https://api.example.com/api/rest/v1",
  "publicBaseUrl": "https://api.example.com",
  "keycloakRealm": "…", "keycloakUrl": "https://auth.example.com",
  "anonKey": "…", "serviceKey": "…",
  "readonly": { "user": "kb_user_…_readonly", "password": "…", "uri": "…", "poolerUri": "…" },
  "canResetDbPassword": true,
  "pooler": { "effective": 20, "source": "plan", "planCeiling": 100 }
}
```

`readonly` is `null` until the companion role exists. `pooler.source` is `project`, `plan`,
`platform` or `none` and says where `effective` comes from. `canResetDbPassword` is only `true`
for a dashboard session that holds the permission. The pooler endpoint is PgBouncer; connect
with `sslmode=require`.

### Passwords

A supplied password must be at least 8 characters with a lowercase and an uppercase letter, a
digit and a special character, and no spaces (400 naming the rule otherwise). Both rotation routes
answer `{ "password": "…" }`; existing connections keep working until they reconnect.

### Read-only role

`POST …/db-readonly-role` creates `<dbUser>_readonly` — a login that can `SELECT` every table and
sequence in the database, including rows protected by row-level security, and can write nothing.
Calling it again repairs the grants and keeps the current password. Answer:
`{ user, password, warnings }`. `DELETE` answers `{ message, warnings }`; rotating or removing a role
that does not exist is 400.

### Pooler connection limit

`maxDbConnections` is a whole number from 1 to the plan's ceiling (403 above it) or `null` to fall
back to the plan or platform default. Answer: `{ maxDbConnections, planCeiling, effective, source }`.
The pooler configuration is regenerated right away.

## Tables, rows and foreign keys

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/tables` | service | tables with `name`, `schema`, `rowCount` |
| POST | `/api/projects/:projectId/tables` | service | create a table — `{ name, columns: [{ name, type, nullable, isPrimary, defaultValue? }] }` |
| DELETE | `/api/projects/:projectId/tables/:tableName` | service | drop a table |
| GET | `/api/projects/:projectId/tables/:tableName/columns` | service | `?schema=` — column definitions |
| POST | `/api/projects/:projectId/tables/:tableName/columns` | service | add a column — `{ name, type, nullable, defaultValue?, isUnique? }` |
| PUT | `/api/projects/:projectId/tables/:tableName/columns/:columnName` | service | alter a column — `{ name?, type?, nullable?, defaultValue?, isUnique? }` |
| DELETE | `/api/projects/:projectId/tables/:tableName/columns/:columnName` | service | drop a column |
| GET | `/api/projects/:projectId/tables/:tableName/rows` | service | `?page=&limit=&schema=&search=&orderBy=&orderDir=` — a page of rows |
| POST | `/api/projects/:projectId/tables/:tableName/rows` | service | insert one row — the body is the row |
| PUT | `/api/projects/:projectId/tables/:tableName/rows` | service | `{ pkWhere, data }` — update the row matching the primary-key values |
| DELETE | `/api/projects/:projectId/tables/:tableName/rows` | service | `{ pkWhere }` — delete the matching row |
| POST | `/api/projects/:projectId/tables/:tableName/deduplicate-rows` | service | `{ keyColumns, preview? }` — delete rows that repeat the key, keeping one |
| GET | `/api/projects/:projectId/tables/:tableName/foreign-keys` | service | foreign keys of a table |
| POST | `/api/projects/:projectId/tables/:tableName/foreign-keys` | service | `{ columnName, foreignTableName, foreignColumnName }` |
| DELETE | `/api/projects/:projectId/tables/:tableName/foreign-keys/:constraintName` | service | drop a foreign key |

`GET …/rows` returns

```json
{ "rows": [ … ], "fields": [ { "name": "id", "dataTypeId": 20 } ],
  "total": 1234, "totalIsApprox": false, "page": 1, "limit": 50, "totalPages": 25, "rlsBypassed": true }
```

`limit` defaults to 50 and is capped at the project's row limit (`max-rows` above). Each row also
carries `_bf_ctid`, the physical row address the dashboard grid uses. `rlsBypassed` tells you the
rows were read as the owner — a policy-bound caller may see fewer.

`deduplicate-rows` takes 1–24 distinct key columns. With `preview: true` it only counts
(`{ preview: true, rowsToDelete, previewCapped? }`); otherwise it deletes in batches and answers
`{ preview: false, deleted, partial?, batchesRun? }` — `partial: true` means more duplicates remain
and the call should be repeated.

Every write is recorded in the project's activity log.

## Database objects

All `session`; any member of the project's team may use them. Identifiers must match
`^[A-Za-z_][A-Za-z0-9_]*$` (400 `Invalid <what> name` otherwise). Objects are listed from the
`public` schema.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/database/indexes` | session | `name`, `table`, `definition`, `isUnique`, `isPrimary`, `size` |
| POST | `/api/projects/:projectId/database/indexes` | session | `{ table, columns, unique?, method?, name? }` — `method` is `btree` (default), `hash`, `gin`, `gist` or `brin` |
| DELETE | `/api/projects/:projectId/database/indexes/:name` | session | drop an index |
| GET | `/api/projects/:projectId/database/triggers` | session | `name`, `table`, `definition`, `enabled` |
| POST | `/api/projects/:projectId/database/triggers` | session | `{ name, table, timing: BEFORE\|AFTER, events: [INSERT\|UPDATE\|DELETE], functionName, forEach?: ROW\|STATEMENT }` |
| PUT | `/api/projects/:projectId/database/triggers/toggle` | session | `{ name, table, enabled }` |
| DELETE | `/api/projects/:projectId/database/triggers/:table/:name` | session | drop a trigger |
| GET | `/api/projects/:projectId/database/functions` | session | SQL and PL/pgSQL functions with `args`, `returns`, `language`, `definition` |
| POST | `/api/projects/:projectId/database/functions` | session | `{ sql }` — exactly one `CREATE [OR REPLACE] FUNCTION` statement |
| DELETE | `/api/projects/:projectId/database/functions/:name` | session | `?args=` — the identity arguments, as listed |
| GET | `/api/projects/:projectId/database/extensions` | session | the extensions a project may enable, with `installedVersion` and `enabled` |
| PUT | `/api/projects/:projectId/database/extensions` | session | `{ name, enabled }` — install or remove one |
| POST | `/api/projects/:projectId/database/extensions/defaults` | session | install the default set new projects get |

Write routes answer `{ "message": "…" }`. Statements run with a 30-second timeout.

Extensions a project may enable: `uuid-ossp`, `pgcrypto`, `pg_trgm`, `citext`, `hstore`,
`unaccent`, `fuzzystrmatch`, `btree_gin`, `btree_gist`, `intarray`, `ltree`, `tablefunc`, `cube`,
`earthdistance`, `vector`; anything else is 400 `Extension is not in the allowed list`.
`POST …/extensions/defaults` installs `pg_trgm`, `pgcrypto`, `unaccent`, `btree_gist`, `uuid-ossp`
and `vector` (plus `pg_stat_statements` where the server preloads it) and answers
`{ installed, skipped: [{ statement, error }], error? }` — a missing extension is reported, never
fatal.

## Row-level security

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/database/policies` | session | every `public` table with its RLS flags and policies, plus the `auth.*` helpers present |
| POST | `/api/projects/:projectId/database/policies` | session | create a policy |
| PUT | `/api/projects/:projectId/database/policies/:table/:name` | session | replace a policy (drop and create in one transaction; the name may change) |
| DELETE | `/api/projects/:projectId/database/policies/:table/:name` | session | `?dryRun=true&check=true` — drop a policy |
| POST | `/api/projects/:projectId/database/policies/rls` | session | `{ table, enabled, force?, dryRun?, check? }` — switch RLS on or off for a table |
| POST | `/api/projects/:id/ensure-rls-bootstrap` | session | (re)install the `anon` / `authenticated` / `service_role` roles, `auth.*` helpers and default grants |
| GET | `/api/projects/:id/rls-diagnose` | session | check those roles from the data API's point of view, changing nothing |

A policy body is

```json
{ "table": "todos", "name": "owner can read", "command": "SELECT",
  "roles": ["authenticated"], "permissive": true,
  "using": "user_id = auth.uid()", "withCheck": null,
  "dryRun": false, "check": false }
```

Every mutation answers `{ sql, applied, checked, message }`. `dryRun: true` returns the SQL without
opening a connection; `check: true` runs it inside a transaction that is rolled back, so a mistake
in an expression surfaces as a 400 with Postgres' message and nothing changes. Expressions are
refused when they contain `;`, comments, unbalanced quotes or parentheses, or a statement the SQL
guard forbids. Postgres errors map to 403 (the database user does not own the table), 404 (table or
policy missing), 409 (a policy of that name exists, or the table is locked) and 400 (invalid
expression).

`GET …/policies` answers `{ tables: [{ schema, name, rlsEnabled, rlsForced, policies: [{ name,
command, permissive, roles, using, withCheck }] }], helpers: { uid, jwt, role, email,
uidReadsLegacyClaimKey }, roles }`; `helpers.uid` is `text`, `uuid` or `null` and tells you how to
compare `auth.uid()` with your columns. See [../concepts/security-model.md](../concepts/security-model.md).

`ensure-rls-bootstrap` is idempotent and answers `{ bootstrappedAt, sentinelPassed, rolesPresent,
failedRoles, currentUser }`; `rls-diagnose` answers `{ projectId, onSharedHost, currentUser,
connectingUser, rolesPresent, memberships, setRoleResults, failedRoles, sentinelPassed }`. Use them
when the data API answers `permission denied to set role …`. Projects on a dedicated database host
are refused with 500.

## Importing data

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/projects/import-supabase/validate` | session | `{ supabaseUrl, serviceRoleKey }` → `{ valid, projectName, tableCount }` |
| POST | `/api/projects/import-supabase` | session | start an import job (body below) |
| GET | `/api/projects/import-supabase/jobs/:jobId/status` | session | `{ id, state, progress, result?, failedReason? }` |
| GET | `/api/projects/import-supabase/jobs/:jobId/events` | session | the same as a server-sent event stream |
| POST | `/api/projects/import-supabase/jobs/:jobId/cancel` | session | stop the job; a newly created project is removed, a re-import target is kept |
| POST | `/api/projects/:id/import-supabase/repair-keys` | session | add the source's primary keys to imported tables that lack one |
| POST | `/api/projects/import-export-zip` | session | create or overwrite a project from a basefyio export archive (multipart) |

### Supabase import

```json
POST /api/projects/import-supabase
{
  "supabaseUrl": "https://<ref>.supabase.co",
  "serviceRoleKey": "…",
  "name": "orders",
  "teamId": "<team id>",
  "databasePassword": "…",
  "existingProjectId": "<project id>",
  "mode": "full",
  "repairKeys": false
}
```

`databasePassword` (optional) lets the importer read the source database directly; without it
tables are read over the source's REST API. Users are created with the ids they had at the
source, so `auth.users` references and `auth.uid()` policies keep matching them. Their password
hashes can only be read from the source database: with `databasePassword` they are kept
(encrypted) and checked on each user's first sign-in, which then stores the password in the
project's identity provider; without it users must reset their password. The result's
`auth.passwords` counts the users whose password is waiting for that first sign-in. `existingProjectId` re-imports into a project of the
same team instead of creating one. `mode: "sync"` requires `existingProjectId` and fetches only
what the source has gained; with `repairKeys: true` a sync first adds missing primary keys. The
answer is `{ jobId, project: { id, name, slug }, reimport }`.

For an unknown job id the status route answers 200 `{ "error": "Job not found" }`. The event
stream sends `connected`, then `state` and `progress` events, and ends with `completed`
(`{ progress: <result> }`) or `failed` (`{ error }`). A completed result carries a per-table
reconciliation (`tables[]`: rows at the source, rows imported, rows here, primary-key state); the
same report is stored on the project and shown on its import log.

### Repairing primary keys

```json
POST /api/projects/:id/import-supabase/repair-keys
{ "supabaseUrl": "…", "serviceRoleKey": "…", "databasePassword": "…", "dryRun": true, "tables": ["orders"] }
```

The source credentials are entered again because the platform keeps neither. `tables` (at most
200) defaults to every table without a key. A key is added only where the rows here are unique and
non-null on it, one table per transaction. The answer is `{ dryRun, examined, added, wouldAdd,
skipped, failed, pending, results: [{ table, columns, status, duplicateGroups?, nullRows?, sql?,
error? }] }` with `status` one of `present`, `added`, `would_add`, `no_source_key`,
`column_missing`, `not_unique`, `failed`, `pending`. A call has a 60-second budget; run it again to
finish `pending` tables.

### Archive import

`POST /api/projects/import-export-zip` takes `multipart/form-data` with the archive in the field
`file` and the fields `teamId`, `nameMode` (`existing` keeps the exported name, `new` uses
`newProjectName`) and optional `existingProjectId` to overwrite a project instead of creating one.
It restores the database dump, the auth users and the storage objects found in the archive and
answers `{ project: { id, name, slug }, importedName, appliedName, warnings }`. The upload is held in
memory; for large projects prefer restoring a stored backup (below).

## Export, backups and point-in-time recovery

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/projects/:id/export` | session | `{ includeDatabase?, includeAuth?, includeStorage?, includeConfig? }` → `{ jobId }` |
| GET | `/api/projects/:id/export/jobs/:jobId/status` | session | `{ id, state, progress, result?, failedReason? }` |
| GET | `/api/projects/:id/export/jobs/:jobId/events` | session | the same as a server-sent event stream |
| GET | `/api/projects/:id/export/jobs/:jobId/download` | session | the finished archive (`application/zip`) |
| GET | `/api/projects/:id/backups` | session | stored archives: manual exports and nightly backups |
| POST | `/api/projects/:id/backups/restore` | session | restore a stored archive into this or a new project |
| GET | `/api/projects/:id/pitr/window` | session | the range of instants the database can be recovered to |
| POST | `/api/projects/:id/pitr/restore` | session | `{ targetTime }` — recover the database to that instant |
| POST | `/api/projects/pitr/run-base-backup` | root | take a physical base backup of the whole cluster now |

**Export.** Each part defaults to included. The archive is kept for 24 hours; download it before
then. The [CLI](./cli.md) wraps these routes as `basefyio backup create|status|download`.

**Stored backups.** `GET …/backups` lists `{ objectKey, filename, size, lastModified, kind:
"manual"|"auto", encrypted }`, newest first. Nightly backups (`auto`, 03:00 UTC, database, auth and
configuration — not storage objects) are kept 7 days. Restore with

```json
POST /api/projects/:id/backups/restore
{ "objectKey": "<projectId>/…zip", "kind": "auto", "teamId": "<team id>", "nameMode": "existing", "existingProjectId": "<project id>" }
```

The object key must belong to the project in the path (403 otherwise). An encrypted archive is
decrypted on the way in when the server holds the backup key. The answer is the archive-import
answer above.

**Point in time.** `GET …/pitr/window` answers `{ earliest, latest, continuousFrom, baseBackupCount,
walSegmentCount, retentionDays }`. `POST …/pitr/restore` takes an ISO timestamp that is not in the
future and answers `{ restoredTo, exact: true, message }` when write-ahead log could be replayed to
that instant, or `{ restoredTo, exact: false, baseBackupTaken, message }` when only the nearest
snapshot was available. How recovery works and what it covers:
[../POINT_IN_TIME_RECOVERY.md](../POINT_IN_TIME_RECOVERY.md).

## Backup health, restore verification and off-site copies

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:id/backups/health` | session · token `backups:read` | off-site copy state, local encryption and the latest restore verifications |
| GET | `/api/projects/:id/backups/verifications` | session · token `backups:read` | `?limit=` (1–50, default 10) — restore-verification history |
| POST | `/api/projects/:id/backups/verify` | session · token `backups:write` | restore the newest nightly backup into a throwaway database now → 202 `{ verificationId }` |
| POST | `/api/projects/backups/offsite/reconcile` | root | copy whatever the off-site bucket is missing now → 202 `{ message }` |

`GET …/backups/health` answers

```json
{
  "offsite": { "enabled": true, "encrypted": true, "misconfigured": false, "reason": null,
               "endpoint": "…", "bucket": "…",
               "copies": { "<local key>": { "status": "UPLOADED", "createdAt": "…", "encrypted": true, "error": null } } },
  "localEncryption": false,
  "verification": { "enabled": true, "running": false, "latest": { … } },
  "verifications": [ … ]
}
```

A verification record has `id`, `projectId`, `trigger`, `status` (`RUNNING`, `PASSED`, `FAILED`,
`SKIPPED`), `backupObjectKey`, `backupTakenAt`, `archiveBytes`, `tablesExpected`, `tablesRestored`,
`rowsMismatched`, `psqlErrorCount`, `countsCompared`, `details`, `error`, `requestedBy`, `startedAt`,
`finishedAt` and `durationMs`. Only one verification runs at a time per API instance (409 while one
is running). Configuration and the schedule: [../BACKUP_OFFSITE_AND_VERIFICATION.md](../BACKUP_OFFSITE_AND_VERIFICATION.md).

## Preview branches

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/projects/:id/branches` | session · token `projects:write` | `{ name, dataMode?: "schema"\|"full" }` — create a branch of this project |
| GET | `/api/projects/:id/branches` | session · token `projects:read` | the project's branches |
| DELETE | `/api/projects/:id/branches/:branchId` | session · token `projects:write` | move a branch to the trash |

A preview branch is a separate project in the same team whose database is populated from the
parent: `schema` (default) copies tables, functions and policies; `full` also copies every row and
is refused for databases larger than `BRANCH_MAX_DB_MB` (default 2048). `name` is 2–40 lowercase
letters, digits and hyphens, unique per parent. A parent may have `BRANCH_LIMIT_PER_PROJECT`
(default 3) live branches (409 beyond); a branch cannot be branched again; only active,
relational projects on the shared cluster can be branched; the plan must include branches (403
otherwise). Branches do not count against the plan's project quota.

Create answers `{ project: { id, name, slug, status, teamId, createdAt }, previewBranch: {
parentProjectId, parentName, parentSlug, branchName, dataMode, syncStatus, syncError } }` at once;
the copy runs in the background and `syncStatus` moves from `pending` to `ready` or `failed`. The
list answers `[{ id, name, slug, status, branchName, dataMode, syncStatus, syncError, createdAt,
createdBy }]`. Delete answers `{ "message": "Preview branch moved to trash" }`.

## Errors

| Status | When |
|---|---|
| 400 | validation; `Invalid <what> name`; a weak password; `Row limit must be 1,000, 10,000, or 100,000`; `targetTime` invalid or in the future; a branch name, mode or size that is not allowed; `This project has no read-only role` |
| 401 | no credential, or a credential this tier does not accept (an API token on a `session` route) |
| 403 | anon key on a `service` route; not a member of the team; missing team permission; plan ceiling exceeded; API token without the scope (`API token is missing required scope(s): …`); `root` routes for anyone else |
| 404 | `Project not found`; `Preview branch not found`; `Export job not found` |
| 409 | a restore verification is already running; a branch name is taken or the branch limit is reached; a policy name exists or the table is locked |
| 500 | RLS bootstrap on a dedicated-host project; a database operation the server could not complete (the message names it) |

## Related

- [sql-api.md](./sql-api.md) — run SQL as the owner or under a key's role
- [project-users-api.md](./project-users-api.md) — the project's end users
- [../concepts/security-model.md](../concepts/security-model.md) — keys, roles and policies
- [../API_TOKENS.md](../API_TOKENS.md) — which routes accept an API token
- [cli.md](./cli.md) — the same operations from the terminal

Source: `apps/platform-api/src/modules/projects/projects.controller.ts`, `projects.service.ts`,
`project-data.controller.ts`, `project-data.service.ts`, `project-database.controller.ts`,
`project-database.service.ts`, `project-provisioning.service.ts`, `project-policies.controller.ts`,
`project-policies.service.ts`, `supabase-import.service.ts`, `supabase-import-keys.service.ts`,
`project-archive-import.service.ts`, `project-export.service.ts`, `project-pitr.service.ts`,
`backups/project-backups.controller.ts`, `backups/backup-offsite.service.ts`,
`backups/backup-verification.service.ts`, `branches/project-branches.controller.ts`,
`branches/project-branch.service.ts`, `branches/dto/create-preview-branch.dto.ts`.
