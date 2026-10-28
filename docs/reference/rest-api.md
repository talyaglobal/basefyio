# Table data API (`/api/rest/v1`)

Reads and writes rows of a project's tables through URL parameters, using the PostgREST query
grammar: a client written for `postgrest-js` or `supabase-js` can point at a basefyio project
without a rewrite. Every statement runs under the caller's database role, so row-level
security applies exactly as it does in SQL.

The API speaks two dialects, chosen per request:

- **Platform** (default) — what basefyio-js and basefyio-python read: reads answer
  `{ data, count }`, writes `{ count }`, `rpc` an array of rows, errors
  `{ statusCode, message, code?, timestamp }`.
- **PostgREST** — what supabase-js and postgrest-js expect: bare arrays, `Content-Range`,
  `Prefer:` hints, 201/204, 406 for `.single()`, errors `{ code, message, details, hint }`.
  A request is served this way when it carries any of `X-Client-Info: supabase-*` /
  `postgrest-*`, `Accept-Profile`, `Content-Profile`, an `Accept: application/vnd.pgrst.*`
  media type, or the explicit opt-in `X-Basefyio-Compat: postgrest`. supabase-js and
  postgrest-js always send the first two, so pointing one at `https://<api>/api` just
  works. `REST_SUPABASE_COMPAT=off|always` on the server disables or forces it.

The sections below describe the platform dialect first and the PostgREST differences after.

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
| GET | `/api/rest/v1/rpc/:fn` | anon | call a function with its arguments in the query string (`.rpc(fn, args, { get: true })`); HEAD is served here too |

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

`count` is the total number of rows matching the filters, regardless of `limit`/`offset`; the
platform dialect always computes it.

**PostgREST dialect**: the body is the bare array. The total is computed only on
`Prefer: count=exact` (`planned`/`estimated` are treated as exact) and returned in
`Content-Range: <from>-<to>/<total>` (`*/<total>` for an empty page, `/*` when no count was
asked for); the status is 206 when the page is a strict subset of the total, 200 otherwise.
`HEAD` runs the count only. `Accept: application/vnd.pgrst.object+json` (`.single()`) returns
one object, or 406 `PGRST116` when the query matched zero or several rows. A `Range: 0-9`
header pages like `offset`/`limit`. `Accept-Profile` must be `public` (406 `PGRST106`
otherwise); `text/csv`, GeoJSON and `vnd.pgrst.plan` are not served (406 `PGRST107`). In this
dialect `order=col` without `nullsfirst`/`nullslast` follows Postgres (ASC NULLS LAST / DESC
NULLS FIRST), which is what `.order()` expects; the platform dialect keeps its original
default (ASC NULLS FIRST / DESC NULLS LAST).

### Query parameters

| Parameter | Syntax | Notes |
|---|---|---|
| `select` | `col,col2,alias:col3,rel(cols),rel!inner(cols),rel!fk_name(cols)` | columns, aliases and embedded related rows resolved through foreign keys; `*` for all columns |
| `<column>` | `<op>.<value>` | a filter; several filters are ANDed |
| `<column>` | `not.<op>.<value>` | negated filter |
| `or` / `and` | `or=(a.eq.1,b.gte.10)`, `and=(…)`, `not.and(…)`, nested | boolean trees |
| `order` | `col.asc`, `col.desc`, `col.desc.nullslast`, `col.asc.nullsfirst`, comma-separated | |
| `limit` / `offset` | integers | `limit` is capped at 1000 |
| JSON paths | `data->settings->>theme=eq.dark`, `select=data->>name` | `->` keeps JSON, `->>` yields text |

Operators: `eq neq gt gte lt lte like ilike match imatch in is isdistinct fts plfts phfts
wfts cs cd ov sl sr nxl nxr adj`. `in` takes `in.(1,2,3)`; `is` takes `is.null`, `is.true`,
`is.false`; full-text search accepts a language: `fts(english).cat`. Values are always bound,
never interpolated into SQL. A name that is not a valid identifier, an unknown operator or a
malformed tree is 400 `Invalid <what>: "…"`.

Embedded resources need a foreign key between the two tables; the schema cache is refreshed
once when a request names a relation or column it has not seen, so a table you just created
works on the first request.

## Writing

Writes answer `{ "count": n }` unless the request carries `Prefer: return=representation`,
in which case the affected rows are returned.

```
POST /api/rest/v1/todos            body: { "title": "Buy milk" }  or  [ {…}, {…} ]
PATCH /api/rest/v1/todos?id=eq.7   body: { "done": true }
DELETE /api/rest/v1/todos?id=eq.7
```

- An insert body may be one object or an array; in the platform dialect the columns are the
  keys of the first row. 400 `Empty body` / `No columns provided`.
- `PATCH` and `DELETE` without any filter are refused (400), so a missing `?id=eq.…` cannot
  touch every row.
- In the platform dialect upsert is not provided: `on_conflict` is accepted and ignored, and
  `Prefer: resolution=merge-duplicates` has no effect. Use the SDK's `upsert()` (which goes
  through the SQL route) or SQL.
- Every successful write is published to realtime subscribers of the table if the table is
  enabled for realtime (see [../REALTIME_API.md](../REALTIME_API.md)).

**PostgREST dialect**:

- `POST` answers 201 with no body, or the inserted rows under
  `Prefer: return=representation` (`.select()` after the write); `PATCH`/`DELETE` answer 204
  with no body, or 200 with the rows. `Prefer: count=exact` puts the affected count in
  `Content-Range`. `.single()` after a write demands exactly one affected row, otherwise the
  write is rolled back with 406 `PGRST116`.
- Insert columns are the union of every row's keys (or the `columns=` hint the client sends
  for arrays). A key a row lacks is `NULL`, or `DEFAULT` under `Prefer: missing=default`
  (`defaultToNull: false`). An empty array inserts nothing and answers 201 `[]`.
- Upsert: `Prefer: resolution=merge-duplicates` (`.upsert()`) becomes
  `ON CONFLICT (<on_conflict columns, else the primary key>) DO UPDATE SET col = EXCLUDED.col`
  for every inserted column; `resolution=ignore-duplicates` becomes `DO NOTHING`. A table with
  no primary key needs `on_conflict=` (400 otherwise).
- `select=` on a write (`.insert(…).select('id,author:users(name)')`) shapes the returned
  rows like a read, embedded resources included.
- An unfiltered `PATCH`/`DELETE` is still refused, as `{ "code": "21000", … }`.

## Functions (`rpc`)

`POST /api/rest/v1/rpc/<fn>` with a JSON object whose keys are the function's argument names:

```bash
curl -s "$API/rest/v1/rpc/add_to_cart" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"product_id": 42, "qty": 1}'
```

The function must live in the `public` schema. Every argument is bound as a parameter by
name; when the function is overloaded, the overload whose parameter names cover the keys sent
(and whose parameters without defaults are all present) is called. In the platform dialect,
keys the function does not name are ignored and the result rows are returned as an array. A
`SECURITY DEFINER` function runs as the database owner, so policies do not apply inside it;
for that reason it **cannot be called with the anon key alone** (403) — send a signed-in
user's token or call it with the service key from your server.

`GET /api/rest/v1/rpc/<fn>?a=1&b=2` calls it with the arguments from the query string (an
array argument as `{a,b}`); `HEAD` is served the same way.

**PostgREST dialect**: the body is the function's value — a bare scalar or JSON value, one
object for a composite type or `OUT` parameters, an array for `SETOF` (bare values for a
scalar set) — and `void` answers 204. `POST` answers 200. A key no overload names is 404
`PGRST202` (`Could not find the function public.<fn>(<args>) in the schema cache`).
`Prefer: params=single-object`, or a function whose only parameter is an unnamed `json`/
`jsonb`, receives the whole body as that parameter. The definer refusal is
`{ "code": "42501" }` 403. Filtering, ordering or `select=` on an `rpc` result is not
applied yet.

## Examples

```ts
// basefyio-js executes from() through the SQL route; for the PostgREST grammar use fetch or postgrest-js:
const res = await fetch(`${API}/rest/v1/todos?select=id,title&done=eq.false&order=created_at.desc`, {
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
});
const { data, count } = await res.json();
```

```ts
// supabase-js, unchanged: point it at the API root. Its own headers select the PostgREST dialect.
import { createClient } from '@supabase/supabase-js';
const supabase = createClient('https://api.basefyio.com/api', ANON_KEY);
const { data, count, error } = await supabase
  .from('todos')
  .select('id,title,author:users(name)', { count: 'exact' })
  .eq('done', false)
  .order('created_at', { ascending: false })
  .range(0, 19);
await supabase.from('todos').upsert({ id: 7, done: true }).select().single();
const { data: total } = await supabase.rpc('cart_total', { user_id: 42 }); // bare value
```

```python
client.from_("todos").select("id,title").eq("done", False).order("created_at", desc=True).execute()
```

## Errors

| Status | When |
|---|---|
| 400 | `Invalid table name`; parser errors `Invalid column: "…"`; `Empty body`; `No columns provided`; `No data to update`; a write without filters; `Function "<fn>" not found`; a Postgres error from your statement (its message) |
| 401 | missing/invalid key; invalid Bearer token |
| 403 | `Function "<fn>" is SECURITY DEFINER …`; key of another project; `Project not found or inactive` |
| 404 | unknown table (surfaced as a Postgres error on the relation) |

**PostgREST dialect**: every error is `{ "code", "message", "details", "hint" }`, which
postgrest-js returns verbatim as `error`. A Postgres error carries its SQLSTATE as `code`
with PostgREST's status for it (`23505`/`23503` → 409, `42501` → 403, or 401 for the
anonymous role, `42P01`/`42883` → 404, `P0001` → 400, connection and resource classes → 503,
…). The API's own codes: `PGRST100` malformed request, `PGRST116` `.single()` mismatch (406),
`PGRST106` schema other than `public` (406), `PGRST107` unsupported media type (406),
`PGRST200` no relationship for an embed, `PGRST204` unknown column, `PGRST205` unknown table
(404), `PGRST202` unknown function (404), `PGRST301` missing or invalid key (401), `21000`
unfiltered write.

Source: `apps/platform-api/src/modules/projects/public-api.controller.ts`, `public-api.service.ts`,
`postgrest/parser.ts`, `postgrest/builder.ts`, `postgrest/schema-cache.ts`, `postgrest/types.ts`;
PostgREST dialect: `postgrest/compat.ts`, `postgrest/compat.filter.ts`, `postgrest/errors.ts`,
`postgrest/rpc.ts`, exercised end to end by `public-api.supabase-compat.spec.ts`.

## Rate limits and overload responses

Every request is admitted through three checks after authentication, so a burst from one
project never reaches the database at the expense of everyone else:

- **Per-project rate limit**: a token bucket sized by the plan (`Plan.features.api_rps` and
  `api_burst`; by default Free 50 req/s with a burst of 100, Pro 200/400, Business 500/1000).
  Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`.
  Over the limit the API answers `429` with `code: "rate_limited"` and `Retry-After`.
- **Per-process concurrency**: each API process serves a bounded number of requests at once;
  the next ones wait briefly in line (at most 1.5 s, visible as `X-Admission-Wait-Ms`), and when
  the line is full the request is shed at once with `503`, `code: "overloaded"` and
  `Retry-After: 1`. Dashboard sessions have their own share of the line, so customer traffic
  cannot lock the console out.
- **Restarting instance**: during a deploy a draining process answers `503 overloaded` for new
  work while it finishes the requests it has; the load balancer stops sending it traffic.

Clients should retry `429` and `503` with the `Retry-After` delay and jitter, idempotent
requests only. The platform operator runs these checks in `log` mode first (every decision is
counted, nothing rejected) and switches to `enforce` after reading a week of counters; see
`ADMISSION_MODE` in the configuration reference.
