# basefyio Python client

A small, typed Python client for a basefyio project: table queries, end-user
authentication, file storage, database functions and raw SQL, all over the
platform's HTTP API. The only dependency is [`httpx`](https://www.python-httpx.org/).

> **Not yet published.** The package is not on PyPI yet. Install it from the
> repository: `pip install -e packages/sdk-python` (or `pip install packages/sdk-python`).

Requires Python 3.9 or newer.

## Quick start

```python
import basefyio

bf = basefyio.create_client(
    url="https://api.basefyio.com",   # or BASEFYIO_API_URL
    key="<anon key>",                 # or BASEFYIO_ANON_KEY
    project_id="<project id>",        # or BASEFYIO_PROJECT_ID; needed for storage and sql()
)

# Read
todos = bf.from_("todos").select("id,title").eq("done", False).order("id").limit(20).execute()
print(todos.data, todos.count)      # rows, and the total number of matching rows

# Write
bf.from_("todos").insert({"title": "write the docs"}).execute()
bf.from_("todos").update({"done": True}).eq("id", 7).execute()
bf.from_("todos").delete().eq("id", 7).execute()

# Sign a user in; later calls run as that user
bf.auth.sign_in("ada@example.com", "secret")
mine = bf.from_("todos").select("*").execute()

# Files
bf.storage.from_("avatars").upload("ada/avatar.png", open("avatar.png", "rb"))
png = bf.storage.from_("avatars").download("ada/avatar.png").data
```

Every call returns a `BasefyioResponse` with `data`, `error` and (for reads)
`count`. HTTP failures are never raised from these calls; check `error`, or
call `.raise_for_error()` to get an exception instead:

```python
rows = bf.from_("todos").select("*").execute().raise_for_error().data
```

`bf.rpc()` is the one exception: it returns the rows directly and raises
`BasefyioError` on failure.

## Configuration

| argument | environment variable | default | used by |
|---|---|---|---|
| `url` | `BASEFYIO_API_URL` | `https://api.basefyio.com` | everything (`/api` is appended if missing) |
| `key` | `BASEFYIO_ANON_KEY` | required | everything — the project's anon or service key |
| `project_id` | `BASEFYIO_PROJECT_ID` | none | `storage` and `sql()` only |
| `headers` | | `{}` | extra headers on every request |
| `timeout` | | `30.0` s | every request |
| `auto_refresh` | | `True` | refresh a user token shortly before it expires |
| `transport` | | | an `httpx` transport, for tests |

The data and auth routes identify the project from the key; `project_id` is
only needed where the route carries it in its path.

## Queries

`bf.from_(table)` builds one request against the data API and sends it with
`.execute()`. Values travel in the URL and are bound on the server; nothing is
turned into SQL on the client.

| call | sends |
|---|---|
| `.select("id,name")` | `select=id,name` (embedded relations such as `author:users(name)` pass through) |
| `.eq / .neq / .gt / .gte / .lt / .lte(col, v)` | `col=eq.v` … |
| `.like / .ilike(col, "*foo*")` | `col=like.*foo*` (`*` is a wildcard; `%` works too) |
| `.match / .imatch(col, regex)` | regular-expression match |
| `.is_(col, None \| True \| False \| "unknown")` | `col=is.null` … |
| `.in_(col, [1, 2])` | `col=in.(1,2)` — items with commas, parentheses, quotes or spaces are quoted for you |
| `.contains / .contained_by / .overlaps(col, "{a,b}")` | array and JSON containment |
| `.text_search(col, "cat & dog", type="wfts", config="english")` | full-text search |
| `.not_(col, "eq", v)` | `col=not.eq.v` |
| `.or_("a.eq.1,b.eq.2")`, `.and_("…")` | a group, written in the data API's own syntax |
| `.filter(col, op, v)` | any operator the data API knows |
| `.order(col, desc=True, nullsfirst=True)` | `order=col.desc.nullsfirst` (repeatable) |
| `.limit(n)`, `.offset(n)`, `.range(start, end)` | paging; the server caps `limit` at **1000** rows |
| `.single()` / `.maybe_single()` | `data` is the first row or `None` instead of a list |

Writes: `.insert(row_or_rows)`, `.update(values)`, `.delete()`. By default the
affected rows come back in `data` (`returning="representation"`); pass
`returning="minimal"` to get only `count`. An update or delete **must** carry a
filter; the server refuses one that does not, and you will see that in `error`.

`QueryBuilder.to_params()` returns the exact `(key, value)` pairs that will be
sent, which is handy in tests.

## Authentication

```python
bf.auth.sign_up("ada@example.com", "secret", first_name="Ada")
bf.auth.sign_in("ada@example.com", "secret")
bf.auth.get_user()          # GET rest/v1/auth/me
bf.auth.refresh()           # exchange the refresh token
bf.auth.get_session()       # Session(access_token, refresh_token, expires_at, …)
bf.auth.set_access_token("…")  # use a token obtained elsewhere (e.g. from a browser)
bf.auth.sign_out()          # forget the session on this client
```

After signing in, every request carries `Authorization: Bearer <token>` next
to the project key, so row-level security policies see the user. With
`auto_refresh=True` (default) a token within 30 seconds of expiry is refreshed
before it is used. A refresh the server rejects (4xx) ends the session; a
network failure keeps it so you can retry.

## Storage

```python
bucket = bf.storage.from_("avatars")
bucket.upload("ada/avatar.png", b"...", content_type="image/png")  # bytes, file object or path
bucket.download("ada/avatar.png").data                              # bytes
bucket.list(prefix="ada/")
bucket.remove(["ada/avatar.png"])
bucket.create_signed_url("ada/avatar.png", expires_in=600)          # {"url": …, "expiresIn": 600}
bucket.get_public_url("ada/avatar.png")                             # str for a public bucket, else None
bucket.get_download_url("ada/avatar.png")                           # the API download URL (needs the apikey header)

bf.storage.list_buckets()
bf.storage.create_bucket("docs", public=False)
bf.storage.update_bucket("docs", public=True)
bf.storage.delete_bucket("docs")
```

What a key may do depends on the authority it carries:

| caller | may |
|---|---|
| anon key alone | `download` |
| anon key + signed-in user | `list`, `upload`, `download`, `remove`, `create_signed_url`, `get_public_url`, `list_buckets` |
| service key | everything, including `create_bucket`, `update_bucket`, `delete_bucket` |

A single upload is capped at 50 MB by the platform.

## Database functions and SQL

```python
bf.rpc("hello", {"name": "world"})             # POST rest/v1/rpc/hello → list of rows
bf.sql("select * from todos where id = $1", [7])  # bound values; needs project_id
```

Always pass values as `params` to `sql()`, never inside the query string.

## Errors

`BasefyioError` carries `message` (what the API said), `status` (HTTP status,
or `None` for a transport failure), `code` (for example `PGRST100` for a
query the data API could not parse) and `details`.

## Relationship to the JavaScript SDK

The surface mirrors `basefyio-js`: `from_()` ↔ `from()`, `auth`, `storage`,
`rpc()`, `sql()`, and the `{data, error}` response shape. One difference:
`from_()` here speaks to the `rest/v1` data API (filters in the URL, bound on
the server), while the JavaScript builder composes SQL for `/sql/execute`.
Both reach the same database under the same role mapping, so a policy that
applies to one applies to the other.

## Development

```bash
cd packages/sdk-python
uv run --no-project --python 3.12 --with pytest --with "httpx>=0.27,<1" -- pytest -q
```

The tests run against a mocked `httpx` transport; no server is needed.

## License

MIT — see `LICENSE`.
