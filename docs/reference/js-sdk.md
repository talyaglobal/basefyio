# JavaScript SDK (`basefyio-js`)

The TypeScript/JavaScript client for a basefyio project: authentication, tables, SQL,
functions, storage, collections, the Data Engine and realtime, from a browser or Node.
Published on npm as `basefyio-js` (MIT); source in `packages/sdk`.

```bash
npm install basefyio-js
```

```ts
import { createClient } from 'basefyio-js';

const bf = createClient({
  apiUrl: 'https://api.basefyio.com',      // the API origin; "/api" is appended for you
  projectId: '3f2b8c1e-…',
  apiKey: 'kb_anon_…',                     // the anon key in a browser; the service key only on a server
});
```

Options left out fall back to `BASEFYIO_API_URL`, `BASEFYIO_PROJECT_ID` and
`BASEFYIO_ANON_KEY` from `process.env` (Node and other runtimes that provide it); `apiUrl`
defaults to `https://api.basefyio.com`. A browser bundle has no `process.env`, so pass the
values explicitly there (for example from `import.meta.env.VITE_…` under Vite). Further options:
`autoRefreshToken` (default `true`) and `headers` (sent on every request).

This page describes `basefyio-js` 2.3.0 as it is in `packages/sdk`. Second-factor and anonymous
sign-in, realtime channels (presence and broadcast), image transforms, resumable uploads and
storage access rules are new in 2.3.0; the npm release 2.2.0 has everything else on this page.

Every method returns `{ data, error }` — `error` is `{ message, status?, code? }` and is never
thrown — except `rpc()`, which returns the rows directly, and the realtime calls. `code` is set
when the API answers with a machine-readable code (for example `mfa_required`,
`totp_required`, `invalid_code`).

## Authentication — `bf.auth`

| Method | Calls | Notes |
|---|---|---|
| `signUp({ email, password, firstName?, lastName? })` | `POST /rest/v1/auth/signup` | tokens; `emailVerified` false when the project requires verification |
| `signIn({ email, password, totp? })` | `POST /rest/v1/auth/signin` | returns `{ data, error, mfa }`; when `mfa` is set, finish with `verifyMfa` |
| `verifyMfa(challengeId, code, { recovery? })` | `POST /rest/v1/auth/mfa/challenge` | completes a sign-in challenge |
| `getMfaStatus()` | `GET /rest/v1/auth/mfa` | `{ enrolled, enrollmentRequired, recoveryCodesLeft, verifiedAt }` |
| `enrollMfa({ challengeId? })` | `POST /rest/v1/auth/mfa/enroll` | `{ secret, otpauthUrl, … }` — render `otpauthUrl` as a QR code |
| `verifyMfaEnrollment(code, { challengeId? })` | `POST /rest/v1/auth/mfa/verify-enrollment` | `{ enabled: true, recoveryCodes }` (show once); plus tokens when a challenge was used |
| `disableMfa(code, { recovery? })` | `POST /rest/v1/auth/mfa/disable` | |
| `regenerateRecoveryCodes(code)` | `POST /rest/v1/auth/mfa/recovery-codes` | |
| `signInAnonymously()` | `POST /rest/v1/auth/signin/anonymous` | tokens with `isAnonymous: true`; the project must allow it |
| `upgradeAnonymous({ email, password, firstName?, lastName? })` | `POST /rest/v1/auth/anonymous/upgrade` | same user id, now an account |
| `signOut()` | — | clears the session locally |
| `verifyEmail(otp)`, `forgotPassword(email)`, `resetPassword(otp, newPassword)` | the matching routes | |
| `sendMagicLink(email)`, `verifyMagicLink(otp)` | | |
| `changeEmail(newEmail)`, `confirmChangeEmail(otp)` | | needs a session |
| `requestReauth()`, `verifyReauth(otp)` | | re-authentication for sensitive actions |
| `inviteUser(email)` | `POST /rest/v1/auth/invite` | service key only |
| `signInWithProvider(provider, { redirectTo? })` | `GET /rest/v1/auth/signin/:provider` | `provider` is a configured provider id such as `google` or `github`; in a browser, navigates to the provider |
| `handleProviderCallback()` | — | reads the tokens the callback put in `location.hash`, stores them, clears the hash |
| `getUser()` | `GET /rest/v1/auth/me` | |
| `getSession()`, `getAccessToken()`, `setAccessToken(token)`, `isAnonymous()` | — | local session; `isAnonymous()` reads the `is_anonymous` claim of the current token |
| `refreshSession()` | `POST /rest/v1/auth/refresh` | also runs automatically before expiry when `autoRefreshToken` is on |
| `onAuthStateChange((event, session) => …)` | — | events `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED`, `EMAIL_VERIFIED`, `EMAIL_CHANGED`; returns `{ unsubscribe }` |

Once a user is signed in, the client sends `Authorization: Bearer <accessToken>` with every
request, so tables, storage and SQL run as that user under row-level security. The session is
kept in memory only; persist `getSession()` yourself if you need it across reloads.

```ts
const res = await bf.auth.signIn({ email, password });
if (res.mfa) {
  // a second factor is required: res.error is { code: 'mfa_required' } and there is no session yet
  const done = await bf.auth.verifyMfa(res.mfa.challengeId, await askForCode());
  if (done.error) show(done.error.message);
} else if (res.error) {
  show(res.error.message);
}
```

Check `mfa` before `error`: a sign-in that needs a second factor reports
`error.code === 'mfa_required'` as well, so code written before MFA existed sees it as a
sign-in without a session rather than as a success.

## Tables — `bf.from(table)`

A chainable query builder that compiles to **SQL with bound parameters** and runs it through
`POST /api/sql/execute` under the caller's role (it does not use the PostgREST route; for
that grammar see [rest-api.md](./rest-api.md)). Await the builder to execute it.

```ts
const { data } = await bf.from<Todo>('todos')
  .select('id,title,done')
  .eq('done', false)
  .order('created_at', { ascending: false })
  .limit(20);

await bf.from('todos').insert({ title: 'Buy milk' });
await bf.from('todos').insert([{ title: 'a' }, { title: 'b' }]);
await bf.from('todos').update({ done: true }).eq('id', 7);
await bf.from('todos').delete().eq('id', 7);
await bf.from('settings').upsert({ key: 'theme', value: 'dark' }, { onConflict: 'key' });
```

| Group | Methods |
|---|---|
| operation | `select(columns = '*')`, `insert(row \| rows)`, `update(patch)`, `delete()`, `upsert(rows, { onConflict })` |
| filters | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `not(column, operator, value)` |
| boolean | `or((q) => q.eq('status', 'active').eq('role', 'admin'))`; `orRaw(sql)` exists but interpolates your string — prefer `or()` |
| shape | `order(column, { ascending?, nullsFirst? })`, `limit(n)`, `offset(n)`, `range(from, to)`, `single()`, `maybeSingle()` |
| debugging | `toSQL()`, `toQuery()` → `{ text, params }` |

Column and table names are quoted as identifiers; values are always bound. A refused statement
(see the SQL guard in [sql-api.md](./sql-api.md)) comes back as `error`.

## SQL and functions

```ts
const { data } = await bf.sql<{ n: number }>('select count(*)::int as n from todos where user_id = $1', [userId]);
const rows = await bf.rpc<Cart>('add_to_cart', { product_id: 42, qty: 1 });   // POST /rest/v1/rpc/add_to_cart
const { data: tables } = await bf.listTables();            // GET /projects/:id/tables (service key)
const { data: cols } = await bf.getColumns('todos');        // GET /projects/:id/tables/todos/columns
```

Pass values as the second argument of `sql()`, never inside the string: the API scans the
statement text — string literals included — for forbidden operations.

## Storage — `bf.storage`

```ts
const avatars = bf.storage.from('avatars');
await avatars.upload(`${user.id}/me.png`, file, { contentType: 'image/png' });
const { data: objects } = await avatars.list(`${user.id}/`);
const { data: signed } = await avatars.createSignedUrl(`${user.id}/me.png`, { expiresIn: 600 });
const { data: blob } = await avatars.download(`${user.id}/me.png`);
await avatars.remove([`${user.id}/me.png`]);
const url = avatars.getPublicUrl('banner.png');                                   // download route
const thumb = avatars.getPublicUrl('banner.png', { transform: { width: 320, format: 'webp' } }); // render route

const { data: stored } = await avatars.uploadResumable('talks/keynote.mp4', bigFile, {
  chunkSize: 8 * 1024 * 1024,      // the server clamps it to 5–64 MiB
  onProgress: ({ uploaded, total, percent }) => setProgress(percent),
  signal: abortController.signal,  // also maxRetries (default 3), retryDelayMs (default 500)
});
await avatars.resumeUpload(sessionId, bigFile);              // continue a session after a crash or reload
const { data: session } = await avatars.getUploadSession(sessionId);
await avatars.abortUpload(sessionId);
await avatars.createUploadSession('talks/keynote.mp4', bigFile.size, { contentType: 'video/mp4' }); // drive the chunks yourself
```

`getPublicUrl(path)` without a transform returns the download route's URL **without a key**,
so it only works where you can add the `apikey` header yourself; a browser `<img src>` cannot.
With a `transform`, the URL carries the anon key as `?apikey=` and loads directly. For a
private object you hand to a browser, use `createSignedUrl()`.

Bucket administration (service key): `bf.storage.listBuckets()`, `createBucket(name,
{ public? })`, `updateBucket(name, { public })`, `deleteBucket(name)`; access rules:
`getPolicies()`, `setBucketPolicy(bucket, { mode, pathPrefix? })`,
`removeBucketPolicy(bucket, pathPrefix?)` with modes `public-read`, `authenticated-read`,
`owner-only`. Most object routes need a signed-in user (download and render accept the anon
key alone); see [storage-api.md](./storage-api.md).

## Collections — `bf.collection(name)` and `bf.collections`

```ts
const posts = bf.collection<Post>('posts');
await posts.insert({ title: 'Hello', status: 'draft' });
const { data } = await posts.find({ status: 'published', views: { $gte: 100 } }).sort('views', 'desc').limit(10);
const { data: one } = await posts.findById(id);
await posts.updateById(id, { views: 42 });   await posts.replaceById(id, doc);   await posts.deleteById(id);
const { data: n } = await posts.count({ status: 'draft' });
await bf.collections.create('posts');  await bf.collections.list();  await bf.collections.drop('posts'); // service key
```

Filter grammar in [collections-api.md](./collections-api.md).

## Data Engine — `bf.data`

```ts
const orders = bf.data.entity<Order>('orders');
await orders.insert({ total: 12.5 });
const { data: page } = await orders.find({ status: 'open' }).sort('createdAt', 'desc').limit(20); // { data, total, hasMore, nextCursor? }
await orders.get(id);  await orders.update(id, patch);  await orders.replace(id, doc);  await orders.delete(id);
await bf.data.listEntities();  await bf.data.health();
```

Service key only; the module is optional on the server ([data-engine-api.md](./data-engine-api.md)).

## Realtime — `bf.realtime`

Data changes, presence and client-to-client broadcast over one Server-Sent Events stream.
Tables and collections deliver changes only after they are enabled (dashboard → Realtime, or
the bindings route). When a user is signed in, their token is sent with the stream, so a table
with row-level security delivers only the rows that user may select.

```ts
// changes
const sub = bf.realtime.subscribe({ table: 'todos', event: '*' }, (change) => {
  // change: { eventId, type: 'INSERT'|'UPDATE'|'DELETE', kind, entity, new, old, commitTimestamp }
});
sub.unsubscribe();

// a named channel with presence and broadcast
const room = bf.realtime.channel('room-1', { presenceKey: 'auto', presenceMeta: { name } })
  .on('presence', { event: 'sync' }, () => render(room.presenceState()))
  .on('broadcast', { event: 'cursor' }, (msg) => draw(msg.payload));
room.on('data_change', { table: 'todos', event: 'INSERT' }, (change) => add(change.new)); // same connection
await room.subscribe();
await room.send({ event: 'cursor', payload: { x, y } });    // POST /realtime/v1/broadcast; { echo: true } to receive it yourself
await room.track({ name: 'Ada' });  await room.untrack();
room.unsubscribe();

await bf.realtime.broadcast('room-1', 'cursor', { x, y });  // without a channel object
```

**Transport.** With nobody signed in, the client opens the stream with `EventSource` and the
anon key in the URL. Once a user is signed in, it reads the stream with `fetch` so the key and
the user's token travel as headers, never in a URL (it falls back to `EventSource` with
`?access_token=` where streaming `fetch` is unavailable). The client that `createClient()` builds
always uses this automatic choice; to force one, construct
`new RealtimeClient(apiUrl, apiKey, { transport: 'fetch' | 'eventsource', tokenAccessor })`
yourself. Reconnection uses exponential backoff (1 s doubling to 15 s). Protocol details in
[../REALTIME_API.md](../REALTIME_API.md).

## Types

All public types are exported from the package root: `BasefyioClientOptions`,
`BasefyioResponse`, `BasefyioError`, `AuthTokens`, `Session`, `User`, `MfaChallenge`,
`MfaEnrollment`, `MfaStatus`, `SignInResponse`, `StorageBucket`, `StorageObject`,
`ImageTransform`, `StoragePolicy`, `UploadSession`, `UploadProgress`, `RealtimeChangePayload`,
`RealtimePresenceMember`, `RealtimeBroadcastMessage`, `FilterOperator`, `SqlResult`,
`CollectionInfo`, `Document`, `NoSqlFilter`, `DataEnginePage`, `EntityInfo`, and the client
classes (`BasefyioClient`, `AuthClient`, `QueryBuilder`, `StorageClient`, `StorageBucketApi`,
`CollectionClient`, `DataEngineClient`, `RealtimeClient`, `RealtimeChannel`).

## Node

The SDK uses the global `fetch` (Node 18+). Realtime without a signed-in user uses
`EventSource`, which Node ships globally from version 22; on older Node assign a polyfill to
`globalThis.EventSource`. Never put the service key in code that reaches a browser; create a
second client with it on the server when you need to bypass policies.

Source: `packages/sdk/src/BasefyioClient.ts`, `lib/fetch.ts`, `lib/types.ts`,
`modules/auth.ts`, `modules/database.ts`, `modules/storage.ts`, `modules/collection.ts`,
`modules/data-engine.ts`, `modules/realtime.ts`.
