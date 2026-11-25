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
| `session` | a dashboard session (`Authorization: Bearer <Keycloak JWT>`) only. Keys are refused with 401; an API token is refused with 403 `API tokens are not accepted on this route; it needs a dashboard session.` |
| `session · token` | a dashboard session or an [API token](api-tokens.md) (`bf_pat_…`) holding the scope named in the row. |
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
| POST | `/api/projects` | session · token `projects:write` | create a project — `{ name, teamId, description?, databaseType?, dbPassword?, computeTier?, region?, dataAccess?, starter? }` |
| GET | `/api/projects/compute-options` | session · token `projects:read` | `?teamId=` — the compute sizes the team may choose, each with `available` and the `reason` it is not |
| GET | `/api/projects/:id/resources` | session only | region, compute, and database and file storage against the plan's limits; see [Pricing and limits](pricing-and-limits.md) |
| GET | `/api/projects` | session · token `projects:read` | `?teamId=` — the team's active projects |
| GET | `/api/projects/deleted` | session · token `projects:read` | `?teamId=` — projects in the trash |
| GET | `/api/projects/deactivated` | session · token `projects:read` | `?teamId=` — deactivated projects |
| GET | `/api/projects/:id` | session · token `projects:read` | one project — no credentials, see [The project object](#the-project-object) |
| PATCH | `/api/projects/:id` | session · token `projects:write` | `{ name?, description?, folderId?, tags? }` |
| GET | `/api/projects/:id/activity` | session · token `logs:read` | `?page=&limit=` — the project's activity log (limit 1–500, default 50). Also answers for a project in the trash, to its team members, until the retention purge removes it |
| PATCH | `/api/projects/:id/max-rows` | session · token `settings:write` | `{ maxRowsPerTable }` — page-size ceiling of the dashboard data grid |
| POST | `/api/projects/:id/move-to-team` | session | `{ teamId }` — move the project to another team (an API token is refused) |
| POST | `/api/projects/:id/deactivate` | session · token `projects:write` | freeze the project without deleting data |
| POST | `/api/projects/:id/reactivate` | session · token `projects:write` | bring a deactivated project back |
| DELETE | `/api/projects/:id` | session · token `projects:write` | move the project to the trash — optional body `{ reasonCode?, reasonLabel?, details? }` |
| POST | `/api/projects/:id/restore` | session · token `projects:write` | take a project out of the trash |
| DELETE | `/api/projects/:id/permanent` | session · token `projects:write` | permanently delete a project that is in the trash |
| GET | `/api/projects/deletion-reasons` | root | `?limit=` — recent deletion events (at most 500): `kind` (`trashed`, `restored`, `permanent`), project name without the trash suffix, team, actor, reason. Permanently deleted projects stay listed. `reasonCode: null` means no reason was chosen; `none` means "None of the above" (rows written before deletion records existed, #190, used `none` for both) |

### Create

```
POST /api/projects
{
  "name": "orders",
  "teamId": "<team id>",
  "description": "…",
  "databaseType": "RELATIONAL",
  "dbPassword": "…",
  "computeTier": "shared",
  "dataAccess": { "dataApi": true, "autoGrantNewTables": false, "rlsOnNewTables": true }
}
```

`name` must not be blank and must be unique within the team (400 `A project with this name
already exists in this team`); keep it to 64 characters, as the dashboard does.
`databaseType` is `RELATIONAL` (default) or `NOSQL`. Creating a
project provisions its PostgreSQL database and database user, its identity realm, the
row-level-security roles, the default extensions and the read-only companion role (see
[Connection and credentials](#connection-and-credentials); an operator can switch the last two off
with `PROVISION_DEFAULT_EXTENSIONS` and `PROVISION_READONLY_ROLE`). A `NOSQL` project also gets its
document-store tenant. The plan's project quota is enforced. The response is the new project
record, including its `anonKey` and — this once — the generated `dbPassword` and the
`serviceKey`. No later response returns them; see [Credentials](#credentials).

Every field after `databaseType` is optional; leaving them out creates the project exactly as
before.

| Field | Values | Default | Meaning |
|---|---|---|---|
| `dbPassword` | 12–128 characters, no spaces, with upper and lower case, a number and a special character | generated | the database password; empty or omitted means the server generates one |
| `computeTier` | `shared`, `micro`, `small`, `medium`, `large`, `xl` | `shared` | `shared` runs on the shared PostgreSQL server. A dedicated size reserves CPU and memory (Micro 0.25 vCPU / 0.5 GB … XL 4 vCPU / 8 GB) and is accepted only when the team's plan includes a dedicated database and the region has room; otherwise 400 `Dedicated compute is not available on the <plan> plan` or `… in this region yet` |
| `region` | `eu-central` | `eu-central` | where the data lives (Germany) |
| `dataAccess.dataApi` | boolean | `true` | `false`: the REST data API (`/api/rest/v1/…`) answers 403 `The Data API is disabled for this project` for every key; the dashboard, the SQL editor, auth and storage keep working |
| `dataAccess.autoGrantNewTables` | boolean | `true` | `false`: new `public` tables and sequences are not granted to `anon` and `authenticated`; grant access table by table. `service_role` is always granted |
| `dataAccess.rlsOnNewTables` | boolean | `false` | `true`: an event trigger enables row-level security on every new `public` table |
| `starter` | `CRM`, `Inventory`, `ERP`, `Marketplace`, `SaaS`, `CMS`, `AI`, `Analytics`, `Files`, `General` | none | relational projects only: create that starter's tables in `public` as the project owner, so the data access settings above apply to them. Each table has `id uuid`, `owner_id text` (defaults to `auth.uid()`) and `created_at`, plus its own columns and foreign keys. A failure does not stop the project; the activity feed says so |

`dataAccess`, when sent, carries all three fields. `GET /api/projects/compute-options?teamId=`
answers `{ region, planAllowsDedicated, dedicatedAvailable, tiers: [{ id, label, vcpu, memoryGb,
available, reason }] }`, the same rule the create call enforces.

### The project object

`GET /api/projects/:id` answers the project's settings: `id`, `name`, `slug`, `description`,
`status`, `teamId`, `databaseType`, `dbName`, `dbHost`, `dbPort` (the pooler endpoint),
`dbUser`, `keycloakRealm`, `anonKey` (public), the data access and region settings, `folder`,
`tags`, `previewBranch`, `github`, `vercel`, `lastImportAt`, `createdAt` and `updatedAt`.
It never carries a credential: `dbPassword`, `serviceKey`, `dbReadonlyPassword` and the
integration tokens are left out for every caller, the team owner included. `GET /api/projects`,
`PATCH /api/projects/:id`, the realtime events and the MCP `get_project` tool leave them out too.
A client that read `dbPassword` or `serviceKey` from this response reads them from
`POST /api/projects/:id/secrets/reveal` instead.

### Data access

`PATCH /api/projects/:id/data-access` (session · token `settings:write`, team owners and admins)
takes any of `{ dataApi, autoGrantNewTables, rlsOnNewTables }` and answers the three settings.
Changing the last two applies the default privileges or the event trigger to the project database
first; tables that already exist keep the grants and the RLS state they have. Projects created
before these settings existed have `dataApi` and `autoGrantNewTables` on and `rlsOnNewTables` off.

### Exposed REST schemas

`GET /api/projects/:id/rest-schemas` (session only, any team member) answers
`{ schemas: ["public", ...], exposedSchemas: [...] }`. `PATCH /api/projects/:id/rest-schemas`
(session only, team owners and admins) takes `{ exposedSchemas: ["r6s"] }`, replaces the list and
answers the same shape. Platform API tokens get 403 on both: widening what the project keys can
reach needs a dashboard session.

- `public` is always served and is not stored; an empty list means `public` only, which is what
  every project has until this is set.
- At most 10 schemas. Names are plain identifiers (letters, digits, `_`, at most 63 characters);
  duplicates are dropped. System and platform schemas (`pg_*`, `information_schema`, `auth`,
  `storage`, `realtime`, `extensions`, `nosql`, `_*`, `supabase_*`, `basefyio*`, …) answer 400.
- Nothing is granted in the database. Grant `USAGE` on the schema and the table privileges the
  API roles need yourself; RLS applies. See the REST reference, *Exposed schemas*.

### Trash, deactivation and permanent deletion

- `DELETE /api/projects/:id` renames the database and its user and disables the realm; nothing is
  erased. The project stays in the trash for 24 hours, then an hourly job removes it for good.
  About six hours before that, whoever created the project and the organization's owners get one
  bell notification and one e-mail with a link to the trash.
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
| GET | `/api/projects/:projectId/connect` | service | connection details with every password and the service key masked, read-only role, extra roles and pooler limit |
| POST | `/api/projects/:id/secrets/reveal` | session | the credentials in clear: database passwords, the URIs that carry them, the service key while unused |
| PATCH | `/api/projects/:id/db-password` | session · token `secrets:write` | `{ password? }` — rotate the owner password (random when omitted) |
| POST | `/api/projects/:id/db-readonly-role` | session · token `secrets:write` | create the read-only companion role, or repair its grants |
| PATCH | `/api/projects/:id/db-readonly-password` | session · token `secrets:write` | `{ password? }` — rotate the read-only role's password |
| DELETE | `/api/projects/:id/db-readonly-role` | session · token `secrets:write` | remove the read-only role |
| GET | `/api/projects/:id/db-extra-roles` | session · token `secrets:read` | the project's extra database roles with their passwords, memberships and limits |
| POST | `/api/projects/:id/db-extra-roles` | session · token `secrets:write` | `{ label, kind?, memberOf?, settings? }` — create an extra LOGIN role, or a NOLOGIN group role with `kind: "group"` (see Extra database roles) |
| PATCH | `/api/projects/:id/db-extra-roles/:roleId` | session · token `secrets:write` | `{ memberOf?, settings? }` — change its memberships or limits |
| PATCH | `/api/projects/:id/db-extra-roles/:roleId/password` | session · token `secrets:write` | `{ password? }` — rotate its password |
| DELETE | `/api/projects/:id/db-extra-roles/:roleId` | session · token `secrets:write` | remove the role |
| PATCH | `/api/projects/:id/db-connection-limit` | session · token `settings:write` | `{ maxDbConnections: number \| null }` — pooled connections allowed to this database |

*Who:* the four write routes need the team permission **reset database password** (team owners
always have it); others get 403 `Your role does not have the "canResetDbPassword" permission in
this team`. The reveal route needs a team owner or admin, or a role with that permission; see
[Credentials](#credentials).

### `GET connect`

```json
{
  "uri": "postgresql://<user>:[YOUR-PASSWORD]@<direct host>:<direct port>/<database>",
  "poolerUri": "postgresql://<user>:[YOUR-PASSWORD]@<pooler host>:6432/<database>",
  "host": "<pooler host>", "port": 5432, "database": "…", "user": "…", "password": null,
  "poolerHost": "<pooler host>", "poolerPort": 6432,
  "restUrl": "https://api.example.com/api/rest/v1",
  "publicBaseUrl": "https://api.example.com",
  "keycloakRealm": "…", "keycloakUrl": "https://auth.example.com",
  "anonKey": "…", "serviceKey": null,
  "readonly": { "user": "kb_user_…_readonly", "password": null, "uri": "…", "poolerUri": "…" },
  "extraRoles": [{ "id": "…", "label": "…", "user": "…", "password": null, "memberOf": "none", "uri": "…", "poolerUri": "…", "createdAt": "…" }],
  "secretsMasked": true,
  "canResetDbPassword": true,
  "canRevealSecrets": true,
  "pooler": { "effective": 20, "source": "plan", "planCeiling": 100 }
}
```

The shape is the one this route always had, with every credential masked: each `password` and
`serviceKey` is `null` and each URI carries `[YOUR-PASSWORD]`. `readonly` is `null` until the
companion role exists. `pooler.source` is `project`, `plan`, `platform` or `none` and says where
`effective` comes from. `canResetDbPassword` and `canRevealSecrets` are only `true` for a dashboard
session that holds the permission. The pooler endpoint is PgBouncer; connect with
`sslmode=require`.

### Credentials

`POST /api/projects/:id/secrets/reveal` (dashboard session only; an API token or a project key
is refused) returns the values `GET connect` masks:

```json
{
  "password": "…",
  "uri": "postgresql://<user>:<password>@<direct host>:<direct port>/<database>",
  "poolerUri": "postgresql://<user>:<password>@<pooler host>:6432/<database>",
  "serviceKey": "bf_service_…",
  "serviceKeyRevealable": true,
  "readonly": { "user": "…", "password": "…", "uri": "…", "poolerUri": "…" },
  "extraRoles": [{ "id": "…", "user": "…", "password": "…", "uri": "…", "poolerUri": "…" }]
}
```

- *Who:* team owners and admins, and any role holding the **reset database password**
  permission. Other members get 403 and work with the masked details.
- Every call writes a `project.secrets_revealed` entry to the project's activity log
  (`GET /api/projects/:id/activity`) naming the person and the fields revealed, never the
  values. When the entry cannot be written the call fails and nothing is revealed.
- The answer carries `Cache-Control: no-store`.
- `serviceKey` follows the [API keys](#api-keys) rule: it is returned only while no application
  has used the key (`serviceKeyRevealable: true`); afterwards it is `null`. Rotate it or create a
  secret key instead.

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

### Extra database roles

Up to ten LOGIN roles per project for applications that connect with their own credentials, named
`kb_xr_<hex>` and labelled for the dashboard. Each is `NOINHERIT` and never a superuser.

- `memberOf`: `"none"`, one of `anon`, `authenticated`, `service_role`, a comma list, or an array such
  as `["anon", "authenticated"]`. Every membership is `INHERIT FALSE, SET TRUE`: the role has none of
  their rights until the session runs `SET [LOCAL] ROLE anon` (or `authenticated`) itself.
- `settings`: run-time limits set on the role, in milliseconds or as `"30s"`, `"5min"`, `"1h"`
  (0 = no limit, at most 24 h): `statementTimeout`, `idleInTransactionSessionTimeout`, `lockTimeout`.
  They are part of the role and are re-applied every time it is repaired; in `PATCH`, `null` removes
  one. Other names are refused with 400.
- The role logs in directly or through the pooler (port 6432) with its own password; the pooler
  configuration is regenerated when a role is created, changed, rotated or removed.

Answer of `GET`, `POST` and `PATCH`: `{ id, label, kind, roleName, password, memberOf, memberships,
settings, createdAt }` — `memberOf` as stored (`"anon,authenticated"`), `memberships` as a list, `settings`
in ms, `password` `null` for a group.

#### Group roles

`POST … { label, kind: "group" }` creates a NOLOGIN role `kb_xg_<hex>` for the project (up to ten):
never a superuser, never `BYPASSRLS`, a member of nothing, with no password. Use it to own
`SECURITY DEFINER` functions and to receive grants, so a function can read a `FORCE ROW LEVEL
SECURITY` table through a policy written for the group, without the owner's or `service_role`'s rights.

- The project owner is a member `WITH INHERIT FALSE, SET TRUE`: it can `ALTER FUNCTION … OWNER TO
  kb_xg_…`, `GRANT … TO kb_xg_…` and `SET ROLE kb_xg_…`, but does not use the group's rights by
  accident.
- A login role lists the group in `memberOf` (`["authenticated", "kb_xg_…"]`). Group memberships
  inherit, like ordinary Postgres groups; built-in roles still need `SET ROLE`.
- Postgres lets a role own a function only in a schema where it may create objects, and the
  project owner cannot grant that on `public`. Keep definer functions in a schema the owner
  creates, and grant what they need before handing them over (`kb_xg_GROUP` stands for your
  group's `roleName`):

  ```sql
  CREATE SCHEMA app_private;
  GRANT USAGE ON SCHEMA app_private TO authenticated, kb_xg_GROUP;
  CREATE FUNCTION app_private.is_member(org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $$ SELECT EXISTS (SELECT 1 FROM org_members WHERE org_id = org AND user_id = auth.uid()) $$;
  REVOKE EXECUTE ON FUNCTION app_private.is_member(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION app_private.is_member(uuid) TO authenticated;
  GRANT SELECT ON org_members TO kb_xg_GROUP;
  CREATE POLICY group_reads ON org_members FOR SELECT TO kb_xg_GROUP USING (true);
  GRANT CREATE ON SCHEMA app_private TO kb_xg_GROUP;
  ALTER FUNCTION app_private.is_member(uuid) OWNER TO kb_xg_GROUP;
  REVOKE CREATE ON SCHEMA app_private FROM kb_xg_GROUP;
  ```

  After the hand-over, change the function's grants as the group (`SET ROLE kb_xg_…`).
- `PATCH` and password rotation do not apply to a group (400). `DELETE` hands everything the group
  owns back to the project owner first, revokes its grants, and removes it from the login roles
  that listed it; nothing the project created is deleted.

### Pooler connection limit

`maxDbConnections` is a whole number from 1 to the plan's ceiling (403 above it) or `null` to fall
back to the plan or platform default. Answer: `{ maxDbConnections, planCeiling, effective, source }`.
The pooler configuration is regenerated right away.

## API keys

These routes take a dashboard session or an [API token](api-tokens.md): `GET` needs
`secrets:read`, every `POST` and `DELETE` (revealing the service key included) needs `secrets:write`.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/projects/:projectId/api-keys` | team member | anon key; service key masked, with `revealable` and `lastUsedAt`; secret keys (name, hint, created, last used); `canManage` |
| POST | `/api/projects/:projectId/api-keys/service/reveal` | team member | the full service key, only until an application first uses it (then 409) |
| POST | `/api/projects/:projectId/api-keys/service/rotate` | credentials permission | a new service key, returned once; the old one is refused from the next request |
| POST | `/api/projects/:projectId/api-keys/anon/rotate` | credentials permission | a new anon key; the old one is refused from the next request — every app shipping it needs the new one |
| POST | `/api/projects/:projectId/api-keys/secret` | credentials permission | `{ name }` → `{ id, name, key, hint }`; the key is returned only here, only its SHA-256 is stored (at most 20 active) |
| DELETE | `/api/projects/:projectId/api-keys/secret/:keyId` | credentials permission | revoke; refused from the next request |

Secret keys (`bf_secret_…`) have the service key's rights and, like it, are accepted only in the `apikey` header. "Credentials permission" is the team role's `canResetDbPassword` (owners always have it).

## Tables, rows and foreign keys

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/tables` | service | tables with `name`, `schema`, `rowCount` |
| POST | `/api/projects/:projectId/tables` | service | create a table — `{ name, columns: [{ name, type, nullable, isPrimary, isUnique?, defaultValue? }] }` |
| PATCH | `/api/projects/:projectId/tables/:tableName` | service | rename a table — `{ name }` (400 when the name is taken or longer than 63 characters) |
| DELETE | `/api/projects/:projectId/tables/:tableName` | service | drop a table |
| GET | `/api/projects/:projectId/tables/:tableName/columns` | service | `?schema=` — column definitions (`name`, `type`, `nullable`, `defaultValue`, `isPrimary`, `isUnique`) |
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
carries `_bf_ctid`, the physical row address the dashboard grid uses to find the row. It is not a column: it is left out of `fields`, and an insert or update never writes it (it only addresses a row, as `match`/`pkWhere`). `rlsBypassed` tells you the
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
| GET | `/api/projects/:projectId/database/indexes` | session · token `schema:read` | `name`, `table`, `definition`, `isUnique`, `isPrimary`, `size` |
| POST | `/api/projects/:projectId/database/indexes` | session · token `schema:write` | `{ table, columns, unique?, method?, name? }` — `method` is `btree` (default), `hash`, `gin`, `gist` or `brin` |
| DELETE | `/api/projects/:projectId/database/indexes/:name` | session · token `schema:write` | drop an index |
| GET | `/api/projects/:projectId/database/triggers` | session · token `schema:read` | `name`, `table`, `definition`, `enabled` |
| POST | `/api/projects/:projectId/database/triggers` | session · token `schema:write` | `{ name, table, timing: BEFORE\|AFTER, events: [INSERT\|UPDATE\|DELETE], functionName, forEach?: ROW\|STATEMENT }` |
| PUT | `/api/projects/:projectId/database/triggers/toggle` | session · token `schema:write` | `{ name, table, enabled }` |
| DELETE | `/api/projects/:projectId/database/triggers/:table/:name` | session · token `schema:write` | drop a trigger |
| GET | `/api/projects/:projectId/database/functions` | session · token `schema:read` | SQL and PL/pgSQL functions with `args`, `returns`, `language`, `definition` |
| POST | `/api/projects/:projectId/database/functions` | session · token `schema:write` | `{ sql }` — exactly one `CREATE [OR REPLACE] FUNCTION` statement |
| DELETE | `/api/projects/:projectId/database/functions/:name` | session · token `schema:write` | `?args=` — the identity arguments, as listed |
| GET | `/api/projects/:projectId/database/extensions` | session · token `schema:read` | the extensions a project may enable, with `installedVersion` and `enabled` |
| PUT | `/api/projects/:projectId/database/extensions` | session · token `schema:write` | `{ name, enabled }` — install or remove one |
| POST | `/api/projects/:projectId/database/extensions/defaults` | session · token `schema:write` | install the default set new projects get |

Write routes answer `{ "message": "…" }`. Statements run with a 30-second timeout.

Extensions a project may enable: `uuid-ossp`, `pgcrypto`, `pg_trgm`, `citext`, `hstore`,
`unaccent`, `fuzzystrmatch`, `btree_gin`, `btree_gist`, `intarray`, `ltree`, `tablefunc`, `cube`,
`earthdistance`, `vector`, `postgis`; anything else is 400 `Extension is not in the allowed list`.
`POST …/extensions/defaults` installs `pg_trgm`, `pgcrypto`, `unaccent`, `btree_gist`, `uuid-ossp`
and `vector` (plus `pg_stat_statements` where the server preloads it) and answers
`{ installed, skipped: [{ statement, error }], error? }` — a missing extension is reported, never
fatal.

## Row-level security

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/database/policies` | session · token `schema:read` | every `public` table with its RLS flags and policies, plus the `auth.*` helpers present |
| POST | `/api/projects/:projectId/database/policies` | session · token `schema:write` | create a policy |
| PUT | `/api/projects/:projectId/database/policies/:table/:name` | session · token `schema:write` | replace a policy (drop and create in one transaction; the name may change) |
| DELETE | `/api/projects/:projectId/database/policies/:table/:name` | session · token `schema:write` | `?dryRun=true&check=true` — drop a policy |
| POST | `/api/projects/:projectId/database/policies/rls` | session · token `schema:write` | `{ table, enabled, force?, dryRun?, check? }` — switch RLS on or off for a table |
| POST | `/api/projects/:id/ensure-rls-bootstrap` | session · token `schema:write` | (re)install the `anon` / `authenticated` / `service_role` roles, `auth.*` helpers and default grants |
| GET | `/api/projects/:id/rls-diagnose` | session · token `schema:read` | check those roles from the data API's point of view, changing nothing |

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

## Advisors

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:id/advisors` | session · token `schema:read` | `?category=security\|performance&refresh=true` — scan the project database for security and performance problems, each with a suggested fix |

Any team member may read the advisors. The scan is read-only: catalog `SELECT`s (`pg_catalog`,
`pg_stat_user_indexes`) in a `READ ONLY` transaction that is always rolled back, 5 s per rule and
at most 200 rows per rule. The fix SQL is shown, never run; copy it into the SQL editor after
reading it. Platform and system schemas (`auth`, `storage`, `extensions`, `realtime`, `pg_*`,
`information_schema`, `_bf_*` and the like) and objects owned by an extension are skipped. A
report is cached for 60 seconds; `refresh=true` scans again.

The answer is

```json
{ "generatedAt": "2026-11-25T10:00:00.000Z",
  "counts": { "total": 2, "error": 1, "warn": 1, "info": 0, "security": 1, "performance": 1 },
  "findings": [{ "id": "rls_disabled:public.todos", "ruleId": "rls_disabled", "severity": "error",
    "category": "security", "title": "Public write access without row-level security",
    "detail": "…", "entity": "public.todos",
    "fixSql": "ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;\n…", "docsHint": "…" }],
  "skippedRules": [] }
```

| Rule | Category | Severity | Finds |
|---|---|---|---|
| `rls_disabled` | security | `error` when `anon` or `authenticated` may insert, update or delete, else `warn` | a table with row-level security off |
| `rls_enabled_no_policy` | security | `info` | a table with row-level security on and no policy (the data API sees no rows) |
| `security_definer_search_path` | security | `warn` | a `SECURITY DEFINER` function without `SET search_path` |
| `unindexed_foreign_key` | performance | `warn` | a foreign key whose columns do not lead any index |
| `unused_index` | performance | `info` | a non-unique, non-constraint index with no scan since statistics began; tables under 1 MB, statistics younger than 7 days and indexes that cover a foreign key are ignored |
| `no_primary_key` | performance | `info` | a table without a primary key |

`skippedRules: [{ ruleId, reason }]` lists rules that could not run (a timeout, a missing
privilege); the other findings still hold. An unknown `category` is 400.

## Importing data

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/projects/import-supabase/validate` | session · token `projects:write` | `{ supabaseUrl, serviceRoleKey }` → `{ valid, projectName, tableCount }` |
| POST | `/api/projects/import-supabase` | session · token `projects:write` | start an import job (body below) |
| GET | `/api/projects/import-supabase/jobs/:jobId/status` | session · token `projects:read` | `{ id, state, progress, result?, failedReason? }` |
| GET | `/api/projects/import-supabase/jobs/:jobId/events` | session · token `projects:read` | the same as a server-sent event stream |
| POST | `/api/projects/import-supabase/jobs/:jobId/cancel` | session · token `projects:write` | stop the job; a newly created project is removed, a re-import target is kept |
| POST | `/api/projects/:id/import-supabase/repair-keys` | session · token `projects:write` | add the source's primary keys to imported tables that lack one |
| POST | `/api/projects/import-export-zip` | session · token `projects:write` | create or overwrite a project from a basefyio export archive (multipart) |
| POST | `/api/projects/:id/data-imports/inspect` | session · token `data:write` | upload a CSV, XLSX or JSON file → preview and an inferred column plan |
| POST | `/api/projects/:id/data-imports/jobs` | session · token `data:write` | start the import into a new or existing table (plan body) |
| GET | `/api/projects/:id/data-imports/jobs/:jobId/status`, `/events` | session · token `data:read` | job state, or the same as an event stream; send the access token in the `Authorization` header |
| GET | `/api/projects/:id/data-imports/jobs/:jobId/errors` | session · token `data:read` | CSV of the rejected rows: row number, reason, raw row |

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
`newProjectName`) and optional `existingProjectId` to overwrite a project instead of creating one. Overwriting also
requires `confirmProjectName`, the exact name of the target project; without it the request is
refused with 400 and nothing is written. An archive that holds none of `manifest.json`,
`project.json` or `database/dump.sql`, and a file that is not a ZIP, are refused with 400 before any
project is created.
It restores the database dump, the auth users and the storage objects found in the archive and
answers `{ project: { id, name, slug }, importedName, appliedName, warnings }`. The upload is held in
memory; for large projects prefer restoring a stored backup (below).

### Data import (CSV, XLSX, JSON)

The job answers `{ rowsRead, rowsInserted, rowsUpdated, rowsSkippedConflict, rowsBad, errorKey }`; a row that cannot be
read or does not fit its column type is counted in `rowsBad` and listed in the `/errors` CSV with the reason. The dashboard
shows this summary when the job ends. When a new table is created with the conflict mode Skip or Update, the chosen conflict
columns become a `UNIQUE` constraint; if the import fails, the half-created table is dropped. The job routes check that the job
belongs to the project and that the caller is a member of it.

## Export, backups and point-in-time recovery

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/projects/:id/export` | session · token `backups:write` | `{ includeDatabase?, includeAuth?, includeStorage?, includeConfig? }` → `{ jobId }` |
| GET | `/api/projects/:id/export/jobs/:jobId/status` | session · token `backups:read` | `{ id, state, progress, result?, failedReason? }` |
| GET | `/api/projects/:id/export/jobs/:jobId/events` | session · token `backups:read` | the same as a server-sent event stream |
| GET | `/api/projects/:id/export/jobs/:jobId/download` | session · token `backups:read` | the finished archive (`application/zip`) |
| GET | `/api/projects/:id/backups` | session · token `backups:read` | stored archives: manual exports and nightly backups |
| POST | `/api/projects/:id/backups/restore` | session · token `backups:write` | restore a stored archive into this or a new project (the dashboard defaults to a new project; overwriting asks for the project name) |
| GET | `/api/projects/:id/backups/download?objectKey=&kind=manual\|auto` | session · token `backups:read` | download one cloud backup as a zip, decrypted when it is stored encrypted |
| DELETE | `/api/projects/:id/backups?objectKey=` | session · token `backups:write` | delete a manual export (owner, or a role allowed to delete projects); nightly backups follow their retention and cannot be deleted |
| GET | `/api/projects/:id/pitr/window` | session · token `backups:read` | the range of instants the database can be recovered to |
| POST | `/api/projects/:id/pitr/restore` | session · token `backups:write` | `{ targetTime }` — start recovering the database to that instant → 202 job |
| GET | `/api/projects/:id/pitr/restore/:jobId` | session · token `backups:read` | one restore job: status, phase, message, outcome |
| GET | `/api/projects/:id/pitr/status` | session · token `backups:read` | the project's newest restore job, `{ job: … \| null }` |
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
future and answers **202** with a job `{ jobId, status: "queued", phase, message, targetTime, queuePosition, … }`;
the restore runs in the background. Poll `GET …/pitr/restore/:jobId` until `status` is `succeeded`
(`restoredTo`, `exact: true` for a write-ahead-log replay, `exact: false` with an explanatory `message`
when only the nearest snapshot was available) or `failed` (`message` says why and whether the
database changed). One restore per project at a time (409, `details.jobId` names the active one), one
running platform-wide, at most 3 per project per hour (429). How recovery works and what it covers:
[../POINT_IN_TIME_RECOVERY.md](../ops/point-in-time-recovery.md).

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
is running). Configuration and the schedule: [../BACKUP_OFFSITE_AND_VERIFICATION.md](../ops/backup-offsite-and-verification.md).

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
| 401 | no credential, an invalid, revoked or expired API token, or a key on a `session` route |
| 403 | anon key on a `service` route; not a member of the team; missing team permission; plan ceiling exceeded; API token without the scope (`API token is missing required scope(s): …`), on a `session` route, or limited to another team (`This API token is limited to another team.`); `root` routes for anyone else |
| 404 | `Project not found`; `Preview branch not found`; `Export job not found` |
| 409 | a restore verification is already running; a branch name is taken or the branch limit is reached; a policy name exists or the table is locked |
| 500 | RLS bootstrap on a dedicated-host project; a database operation the server could not complete (the message names it) |

## Related

- [sql-api.md](./sql-api.md) — run SQL as the owner or under a key's role
- [project-users-api.md](./project-users-api.md) — the project's end users
- [../concepts/security-model.md](../concepts/security-model.md) — keys, roles and policies
- [../API_TOKENS.md](api-tokens.md) — which routes accept an API token
- [cli.md](./cli.md) — the same operations from the terminal

Source: `apps/platform-api/src/modules/projects/projects.controller.ts`, `projects.service.ts`,
`project-data.controller.ts`, `project-data.service.ts`, `project-database.controller.ts`,
`project-database.service.ts`, `project-provisioning.service.ts`, `project-policies.controller.ts`,
`project-policies.service.ts`, `supabase-import.service.ts`, `supabase-import-keys.service.ts`,
`project-archive-import.service.ts`, `project-export.service.ts`, `project-pitr.service.ts`,
`backups/project-backups.controller.ts`, `backups/backup-offsite.service.ts`,
`backups/backup-verification.service.ts`, `branches/project-branches.controller.ts`,
`branches/project-branch.service.ts`, `branches/dto/create-preview-branch.dto.ts`.
