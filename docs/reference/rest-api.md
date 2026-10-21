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

`count` is the total number of rows matching the filters, regardless of `limit`/`offset`; the
API always computes it (there is no `Prefer: count=` switch).

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

- An insert body may be one object or an array; all rows must have the same keys. 400
  `Empty body` / `No columns provided`.
- `PATCH` and `DELETE` without any filter are refused (400), so a missing `?id=eq.…` cannot
  touch every row.
- Upsert is not provided on this route: `on_conflict` is accepted and ignored, and
  `Prefer: resolution=merge-duplicates` has no effect. Use the SDK's `upsert()` (which goes
  through the SQL route) or SQL.
- Every successful write is published to realtime subscribers of the table if the table is
  enabled for realtime (see [../REALTIME_API.md](../REALTIME_API.md)).

## Functions (`rpc`)

`POST /api/rest/v1/rpc/<fn>` with a JSON object whose keys are the function's argument names:

```bash
curl -s "$API/rest/v1/rpc/add_to_cart" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"product_id": 42, "qty": 1}'
```

The function must live in the `public` schema. Arguments not named by the function are
ignored. The result rows are returned as an array. A `SECURITY DEFINER` function runs as the
database owner, so policies do not apply inside it; for that reason it **cannot be called
with the anon key alone** (403) — send a signed-in user's token or call it with the service
key from your server.

## Examples

```ts
// basefyio-js executes from() through the SQL route; for the PostgREST grammar use fetch or postgrest-js:
const res = await fetch(`${API}/rest/v1/todos?select=id,title&done=eq.false&order=created_at.desc`, {
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
});
const { data, count } = await res.json();
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

Source: `apps/platform-api/src/modules/projects/public-api.controller.ts`, `public-api.service.ts`,
`postgrest/parser.ts`, `postgrest/builder.ts`, `postgrest/schema-cache.ts`, `postgrest/types.ts`.
