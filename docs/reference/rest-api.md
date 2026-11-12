# Table data API (`/api/rest/v1`)

Reads and writes rows of a project's tables through URL parameters, using the PostgREST query
grammar: a client written for `postgrest-js` or `supabase-js` can point at a basefyio project
without a rewrite. Every statement runs under the caller's database role, so row-level
security applies exactly as it does in SQL.

## Authentication

`apikey` header with the anon or service key. With the anon key, add
`Authorization: Bearer <end-user access token>` to act as that user (`authenticated` role);
without it the request is `anon`. The service key runs as `service_role`, which bypasses RLS,
and must never leave your server. This API is exempt from the per-IP rate limit.

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/rest/v1/:table` | anon | select rows |
| POST | `/api/rest/v1/:table` | anon | insert one row or an array of rows |
| PATCH | `/api/rest/v1/:table` | anon | update the rows matched by the filters |
| DELETE | `/api/rest/v1/:table` | anon | delete the rows matched by the filters |
| POST | `/api/rest/v1/rpc/:fn` | anon | call a function in the `public` schema |

"anon" here means any key is accepted by the guard; what the call may *do* is decided by
Postgres grants and policies for the role the key resolves to. New tables grant `SELECT` to
`anon` and full DML to `authenticated` by default — see
[../concepts/security-model.md](../concepts/security-model.md).

## Reading

```
GET /api/rest/v1/todos?select=id,title,done&done=eq.false&order=created_at.desc&limit=20&offset=0
```

Response:

```json
{ "data": [ { "id": 7, "title": "Buy milk", "done": false } ], "count": 1 }
```

The same information is in the `Content-Range` header (`0-19/57`; `*/0` for an empty page), and
`Accept: text/csv` returns the rows as CSV instead of JSON.

### The `count`

`count` is the number of rows matching the filters, regardless of `limit`/`offset`. It is no
longer a full `COUNT(*)` on every request — on a large table that was most of the cost of a
read:

| Mode | How it is computed |
|---|---|
| default (`estimated`) | free when the page comes back short (it already holds the total); otherwise counted exactly up to 10,000 matching rows, and taken from the planner's estimate beyond that |
| `exact` | a full count of every matching row |
| `planned` | the planner's estimate only |
| `none` | not computed; `count` is `null` |

Choose with `Prefer: count=exact` (or `?count=exact`). The `Preference-Applied` response
header says what the number is: `count=exact` or `count=planned` (an estimate). For a total
you page through on a table that may exceed 10,000 matching rows, ask for `count=exact`.

### Query parameters

| Parameter | Syntax | Notes |
|---|---|---|
| `select` | `col,col2,alias:col3,rel(cols),rel!inner(cols),rel!fk_name(cols)` | columns, aliases and embedded related rows resolved through foreign keys; `*` for all columns |
| `<column>` | `<op>.<value>` | a filter; several filters are ANDed |
| `<column>` | `not.<op>.<value>` | negated filter |
| `or` / `and` | `or=(a.eq.1,b.gte.10)`, `and=(…)`, `not.and(…)`, nested | boolean trees |
| `order` | `col.asc`, `col.desc`, `col.desc.nullslast`, `col.asc.nullsfirst`, comma-separated | without `nullsfirst`/`nullslast`, NULLs follow PostgreSQL: last when ascending, first when descending |
| `limit` / `offset` | non-negative integers | at most 1000 rows per request: a larger `limit` returns 1000 (see `Content-Range`); a `limit`/`offset` that is not a whole number is 400 |
| `count` | `exact`, `planned`, `estimated`, `none` | same as the `Prefer: count=` header |
| JSON paths | `data->settings->>theme=eq.dark`, `select=data->>name` | `->` keeps JSON, `->>` yields text; a selected path is labelled by its last key (`name`) unless aliased |

`Range: 0-24` (with `Range-Unit: items`, optional) pages the same way as `offset=0&limit=25`
when the query has no `limit`/`offset` of its own.

Operators: `eq neq gt gte lt lte like ilike match imatch in is isdistinct fts plfts phfts
wfts cs cd ov sl sr nxl nxr adj`. `in` takes `in.(1,2,3)`; `is` takes `is.null`, `is.true`,
`is.false`; full-text search accepts a language: `fts(english).cat`. Values are always bound,
never interpolated into SQL. A filter without an operator (`id=5`), an unknown operator or
order modifier, a name that is not a valid identifier, or a malformed tree is 400 with a
message naming what was wrong.

Embedded resources need a foreign key between the two tables; the schema cache is refreshed
once when a request names a relation or column it has not seen, so a table you just created
works on the first request. With `rel!inner(…)`, the `count` counts only the parent rows that
have a matching child, like the rows themselves.

Value types: `bigint`, `numeric` and other exact numbers of the row itself arrive as JSON
**strings** (`"id": "1"`), so no digit is lost to floating point; inside an embedded resource
they are JSON numbers, because the embed is built as JSON by Postgres.

## Writing

Writes answer `{ "count": n }` unless the request carries `Prefer: return=representation`, in
which case the affected rows are returned (narrowed to `?select=col,alias:col` when given).
`Prefer: return=minimal` answers with no body: `201` for an insert, `204` for an update or
delete.

```
POST /api/rest/v1/todos            body: { "title": "Buy milk" }  or  [ {…}, {…} ]
PATCH /api/rest/v1/todos?id=eq.7   body: { "done": true }
DELETE /api/rest/v1/todos?id=eq.7
```

- An insert body may be one object or an array of objects. The columns come from the first
  row; a later row missing one of them writes NULL there. 400 `Empty body` /
  `No columns provided` / `Every row must be a JSON object…`.
- A large insert is split into statements under Postgres' limit of 65,535 bound values, all in
  one transaction: it lands whole or not at all. The request body is limited to 10 MB.
- `PATCH` and `DELETE` without any filter are refused (400), so a missing `?id=eq.…` cannot
  touch every row.
- Every successful write is published to realtime subscribers of the table if the table is
  enabled for realtime (see [../REALTIME_API.md](../REALTIME_API.md)).

### Upsert

```
POST /api/rest/v1/todos?on_conflict=slug
Prefer: resolution=merge-duplicates, return=representation
body: [ { "slug": "milk", "title": "Buy milk" } ]
```

- `resolution=merge-duplicates` updates the existing row's columns with the ones sent;
  `resolution=ignore-duplicates` keeps the existing row.
- The conflict target is `on_conflict` (unique column(s)), or the primary key when it is
  omitted. Merging needs a target, so a table without a primary key needs `on_conflict`.
- A row that carries only its key has nothing to merge and is left as it is.
- It runs like an insert — same role, same transaction, same batching. Row-level policies
  decide as for an `INSERT`, and for the rows it updates as for an `UPDATE`.
- Realtime publishes an `INSERT` for a new row and an `UPDATE` for a merged one.

## Functions (`rpc`)

`POST /api/rest/v1/rpc/<fn>` with a JSON object whose keys are the function's argument names:

```bash
curl -s "$API/rest/v1/rpc/add_to_cart" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"product_id": 42, "qty": 1}'
```

- Answers `200` with the result rows as an array. A function returning a single value comes
  back as one row keyed by the function name: `[{ "add_to_cart": 3 }]`.
- The body is the arguments object itself, not `{ "args": {…} }`. Keys that are not argument
  names are ignored; arguments with a default may be left out. When the arguments sent fit
  no version of the function, the answer is 400 listing the signatures that exist.
- A `json`/`jsonb` argument receives the JSON value as sent; an array argument (`text[]`)
  takes a JSON array.
- The function must live in the `public` schema. A `SECURITY DEFINER` function runs as the
  database owner, so policies do not apply inside it; for that reason it **cannot be called
  with the anon key alone** (403) — send a signed-in user's token or call it with the service
  key from your server.
- An error the function raises (`RAISE EXCEPTION`) is 400 with its message.

## Examples

```ts
// basefyio-js executes from() through the SQL route (upsert() and rpc() use this API); for the PostgREST grammar use fetch or postgrest-js:
const res = await fetch(`${API}/rest/v1/todos?select=id,title&done=eq.false&order=created_at.desc`, {
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
});
const { data, count } = await res.json();
```

```python
client.from_("todos").select("id,title").eq("done", False).order("created_at", desc=True).execute()
```

## Errors

Error bodies are `{ "statusCode", "message", "code" }`. For a database error `code` is
Postgres' SQLSTATE (`23505` duplicate key, `22P02` invalid input, `42501` missing privilege…);
for a request the API could not parse it is a `PGRST…` code.

| Status | When |
|---|---|
| 400 | `Invalid table name`; a malformed query (filter without operator, unknown operator, bad `order`, `limit`/`offset` not a whole number, bad `Range`); `Empty body`; `No columns provided`; `No data to update`; a write without filters; `Function "<fn>" not found`; arguments that fit no version of the function; a value that does not fit its column (invalid uuid, numeric overflow, check or not-null constraint — the message names the column, constraint or type); malformed JSON in the body |
| 401 | missing/invalid key; invalid Bearer token |
| 403 | `Function "<fn>" is SECURITY DEFINER …`; key of another project; `Project not found or inactive`; `Permission denied: permission denied for table …` (the role has no `GRANT` on the table) or `Permission denied by row-level security policy: …` (a policy refused the row) |
| 404 | unknown table |
| 409 | duplicate key or foreign-key violation (the message carries Postgres' detail) |

Error responses carry the CORS headers too, so a browser can read them.

Source: `apps/platform-api/src/modules/projects/public-api.controller.ts`, `public-api.service.ts`,
`postgrest/parser.ts`, `postgrest/builder.ts`, `postgrest/schema-cache.ts`, `postgrest/types.ts`,
`postgrest/write.ts`, `postgrest/response.ts`, `postgrest/rpc.ts`, `pg-error.util.ts`.
