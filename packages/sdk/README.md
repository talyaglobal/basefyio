# basefyio-js

The JavaScript / TypeScript client for a [basefyio](https://basefyio.com) project: tables, SQL,
database functions, authentication, storage, document collections, the Data Engine and
realtime — from a browser or from Node.

```bash
npm install basefyio-js
```

## Requirements

- **Node 18 or newer** (the SDK uses the global `fetch`, `FormData` and `Blob`), or any modern
  browser, Deno or Bun.
- **Realtime in Node** without a signed-in user uses `EventSource`, which Node ships from
  version 22. On older Node, assign a polyfill to `globalThis.EventSource`.
- ES module and CommonJS builds, with TypeScript types. No runtime dependencies.

## Quick start

```ts
import { createClient } from 'basefyio-js';

const bf = createClient({
  apiUrl: 'https://api.basefyio.com',
  projectId: 'your-project-id',
  apiKey: 'your-anon-key', // the anon key in a browser; the service key only on a server
});

const { data, error } = await bf.from('todos').select('id, title').eq('done', false).limit(20);
```

In Node, `createClient()` with no arguments reads `BASEFYIO_PROJECT_ID`, `BASEFYIO_ANON_KEY` and
`BASEFYIO_API_URL` from the environment. A browser has no environment to read: pass the values
explicitly (for example from `import.meta.env` under Vite).

## How results come back

Every call resolves to `{ data, error }` and never throws (the realtime calls are the
exception). `error` is `{ message, status?, code? }`:

- `status` — the HTTP status, when the API answered;
- `code` — Postgres' SQLSTATE for a database error (`23505` duplicate key, `42501` missing
  privilege), the API's own code otherwise (`PGRST116`, `mfa_required`…), or `network_error` /
  `invalid_request` when the request never got through or the SDK refused it before sending.

Values come back as the database returns them: `bigint`, `numeric` and `count(*)` are
**strings**, so no digit is lost to floating point. A `BigInt` you pass is sent as its decimal
string.

## Tables

```ts
await bf.from('todos').insert({ title: 'Buy milk' }).select('id');
await bf.from('todos').update({ done: true }).eq('id', 7);
await bf.from('todos').delete().eq('id', 7);
await bf.from('settings').upsert({ key: 'theme', value: 'dark' }, { onConflict: 'key' });

const { data: todo } = await bf.from('todos').select().eq('id', 7).single();
const { data: perStatus } = await bf.from('todos').select('done, count(*) as n');
```

- **`update()` and `delete()` need a filter.** Without one they would touch every row, so they
  return an error instead. Pass `{ allowFullTable: true }` when that is really the intent.
- **`single()`** resolves to one object, and to an error (`PGRST116`) when no row or several rows
  match; on an update or delete a filter matching several rows changes nothing.
  `maybeSingle()` allows no row (`data: null`). Add `.limit(1)` to take the first of several.
- **`upsert()`** resolves duplicates on `onConflict`, or on the primary key by default;
  `ignoreDuplicates: true` keeps existing rows.
- A read without `limit()` returns at most 100 rows; `limit()` goes up to 1000.
- `orRaw(sql)` writes its string into the query **unescaped**. Never pass user input to it;
  use `or((q) => …)` instead.
- `toSQL()` shows the statement with its values written in, for reading; `toQuery()` shows what
  is actually sent.

Writing with the anon key needs the table to allow it — a `GRANT` to the role and, with
row-level security on, a policy for the operation. `listTables()`, `getColumns()`, bucket
administration and collection management need the service key.

## Functions

```ts
const { data, error } = await bf.rpc('add_to_cart', { product_id: 42, qty: 1 });
```

Calls a database function in the `public` schema with named arguments. (Earlier releases
returned the rows directly and threw on failure; a successful result is still also the rows
array, but read `data` and check `error` in new code.)

## Authentication

```ts
const { data, error } = await bf.auth.signIn({ email, password });
bf.auth.onAuthStateChange((event, session) => { /* SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT, … */ });
await bf.auth.signOut(); // also revokes the refresh token on the server
```

The session lives in memory unless you opt in to keeping it across reloads:

```ts
const bf = createClient({ projectId, apiKey, auth: { persistSession: true } }); // localStorage by default
await bf.auth.ready();
```

Stored tokens are readable by every script on the page; enable persistence only where that is
acceptable.

## More

- SDK reference: <https://basefyio.com/docs/sdk>
- REST API: <https://basefyio.com/docs/api>
- Source and issues: <https://github.com/talyaglobal/basefyio>

MIT licensed.
