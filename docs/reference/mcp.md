# MCP server

`POST /api/mcp` is basefyio's Model Context Protocol server (Streamable HTTP,
stateless, JSON responses). An AI agent connects with a platform API token
(`bf_pat_…`, see [API_TOKENS.md](../API_TOKENS.md)); the token's scopes decide which
tools the agent is shown and what each call may do.

Source: `apps/platform-api/src/modules/mcp/` (`mcp-tools.ts` is the catalogue,
`mcp.service.ts` the checks, `mcp.controller.ts` the route).

## Request

```
POST /api/mcp
Authorization: Bearer bf_pat_…
Content-Type: application/json
Accept: application/json, text/event-stream
```

The body is one JSON-RPC message (`initialize`, `tools/list`, `tools/call`, …). No
session id is issued; every request stands alone. `GET /api/mcp` answers 405.

| Status | When |
|---|---|
| 200 | the message was handled; a denied tool call is a result with `isError: true` and the reason |
| 401 | no token, not a `bf_pat_` token (dashboard sessions are refused), or the token is revoked or expired; `WWW-Authenticate: Bearer` |
| 403 | the token holds no scope that unlocks any tool |
| 429 | more than 120 requests in a minute for this token (the global per-IP limit applies too) |

## Tools

| Tool | Scope | Service it calls |
|---|---|---|
| `list_teams` | `team:read` | `TeamsService.findAllForUser` (a team-restricted token sees its team only) |
| `list_projects` | `projects:read` | `ProjectsService.findAll`, per team |
| `get_project` | `projects:read` | `ProjectsService.findOne`, returned through an allowlist (no password, keys or tokens) |
| `list_tables` | `schema:read` | `ProjectDataService.listTables` |
| `describe_table` | `schema:read` | `ProjectDataService.getColumns` + `getForeignKeys` |
| `select_rows` | `data:read` | `ProjectDataService.getRows`, at most 200 rows a page |
| `insert_row` | `data:write` | `ProjectDataService.insertRow` + an activity entry |
| `update_rows` | `data:write` | `ProjectDataService.updateRow` + an activity entry |
| `delete_row` | `data:write` | `ProjectDataService.deleteRow` + an activity entry |
| `query_sql` | `sql:read` | `SqlService.execute` with `readOnly: true` |
| `run_sql` | `sql:run` | `SqlService.execute` as the database owner (the SQL editor path) |
| `list_buckets` | `storage:read` | `StorageService.listBuckets` |
| `list_objects` | `storage:read` | `StorageService.listObjects`, at most 1,000 entries |
| `list_auth_users` | `auth:read` | `KeycloakAdminService.listUsers`, at most 100 a page |

Nothing that returns a secret (database password, project keys, connection
strings) and nothing that deletes a project or rotates a key is exposed.

## How each call is checked

1. The token is verified on every HTTP request (`ApiTokensService.verify`): a revoked
   or expired token fails on its next request.
2. The per-request server registers only the tools whose scope the token holds, so
   `tools/list` shows nothing else and an unlisted tool cannot be called.
3. On the call itself the scope is checked again.
4. A `teamId` argument must equal the token's team (when it is team-restricted) and
   name a team the owner belongs to. A `projectId` argument must name a project that
   is not deleted, whose team matches the token's team restriction, and whose team the
   owner belongs to. All three failures give the same answer, so project ids cannot be
   probed.
5. The service then runs with the owner's user id and repeats its own membership check.

The catalogue is validated when the module loads: a tool with no scope or an unknown
scope, a project or team reference under another argument name, or an optional
`projectId` stops the API from booting.

## Read-only SQL

`query_sql` accepts exactly one `SELECT`, `WITH`, `VALUES`, `TABLE` or `EXPLAIN`
statement (`findNonReadStatement` in `sql-guard.ts`, after the usual
`findForbiddenSqlPattern`). It is sent over the extended query protocol, which carries
one statement only, inside `BEGIN READ ONLY` and is always rolled back, so Postgres
itself refuses a write hidden in a data-modifying CTE or a function.

## Audit and limits

Every tool call writes an `audit_logs` row: `action = mcp.<tool>`, `actorRole =
API_TOKEN`, `resourceId` = the project, and `metadata_json` with the token id, tool,
scope, project, outcome (`ok`, `denied`, `error`) and status. Arguments are never
recorded and tokens are never logged. Answers longer than 100,000 characters are cut
and say so.
