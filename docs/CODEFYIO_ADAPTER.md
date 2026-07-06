# Codefyio Marketplace Adapter (basefyio)

Lets the **Codefyio IDE** discover, authenticate against, and drive a basefyio
instance from inside the editor. It is a thin layer **on top of** the existing
platform API — it adds no business logic and changes no existing routes.

- **id:** `basefyio` · **category:** `database`
- **manifest:** [`codefyio.adapter.json`](../codefyio.adapter.json) (repo root)
- **HTTP surface:** `/_codefyio/*` (served at the root, outside the `/api` prefix)
- **In-process client:** [`apps/platform-api/src/codefyio/adapter.ts`](../apps/platform-api/src/codefyio/adapter.ts) → `CodefyioHttpAdapter`

## Safe by default

The adapter ships **inert**: the authenticated routes return **503** until a
Codefyio token verifier is configured. Shipping it never changes existing
behaviour. `/_codefyio/health` and `/_codefyio/manifest` are always public.

## Environment variables

| Var | Required | Purpose |
|-----|----------|---------|
| `CODEFYIO_ORIGIN` | recommended | Only origin allowed by CORS / `frame-ancestors` (e.g. `https://ide.codefyio.com`). |
| `CODEFYIO_AUDIENCE` | no (default `codefyio`) | Expected `aud` claim on Codefyio JWTs. |
| `CODEFYIO_JWT_SECRET` | one of these two | HS256 shared secret to verify Codefyio tokens (self-host / dev / tests). |
| `CODEFYIO_JWKS_URL` | one of these two | RS256 JWKS endpoint to verify Codefyio tokens (production). |
| `CODEFYIO_SESSION_SECRET` | no (falls back to `CODEFYIO_JWT_SECRET`) | HS256 key used to sign our short-lived adapter session tokens. |
| `CODEFYIO_SESSION_TTL` | no (default `3600`) | Adapter session lifetime, seconds. |

If neither `CODEFYIO_JWT_SECRET` nor `CODEFYIO_JWKS_URL` is set, `/auth/exchange`
returns `503 Codefyio adapter is not configured`.

## HTTP endpoints

All JSON. CORS/`frame-ancestors` allow only `CODEFYIO_ORIGIN`. Tokens are never logged.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET  | `/_codefyio/health`   | none | `{ "status":"ok", "version":"1.0.0" }` |
| GET  | `/_codefyio/manifest` | none | Serves the manifest (incl. the action allow-list). |
| POST | `/_codefyio/auth/exchange` | none | Body `{ codefyioToken }`. Verifies the Codefyio JWT (sig + `aud` + `exp`), resolves the matching basefyio account **by email**, returns `{ accessToken, expiresIn, account }`. No second login. |
| GET  | `/_codefyio/resources?cursor=` | session | `{ items:[{id,name,kind,meta}], nextCursor }` — the account's projects. |
| POST | `/_codefyio/action` | session | Body `{ action, resourceId, params }` → `{ ok, result, error? }`. Rejects any action not in the allow-list. |
| GET  | `/_codefyio/events?token=<session>` | session | **SSE** stream of `{ type, resourceId, payload }` (`ready` + heartbeats). `EventSource` can't set headers, so the session token is passed as `?token=`. |

`session` = `Authorization: Bearer <accessToken>` from `/auth/exchange`.

## Actions (least-privilege allow-list)

`/action` rejects anything not listed here (also advertised in the manifest):

| action | params | maps to |
|--------|--------|---------|
| `project.status` | — | project status (`ProjectsService.findOne`) |
| `project.tables` | — | list tables/collections (`CollectionService.listCollections`) |
| `sql.run` | `{ query: string }` | run SQL (`SqlService.execute`) |
| `realtime.list` | — | list realtime bindings |
| `realtime.set` | `{ kind, entity, enabled }` | enable/disable realtime for a table/collection |

`resourceId` is the project id; every action is scoped to a project owned by the
session's team (enforced by the underlying services), so tenants stay isolated.

## Security

- Codefyio JWT signature + `aud` + `exp` verified on exchange (HS256 or RS256/JWKS).
- Adapter session tokens are short-lived HS256 JWTs (`aud: codefyio-adapter`),
  verified on every authed call.
- CORS + CSP `frame-ancestors` restricted to `CODEFYIO_ORIGIN`.
- `/action` enforces the manifest allow-list (least privilege); unknown actions → `403`.
- No tokens or secrets are ever logged.

## Using the in-process client

```ts
import { CodefyioHttpAdapter } from './codefyio/adapter';

const adapter = new CodefyioHttpAdapter();
await adapter.init({ baseUrl: 'https://api.basefyio.com', codefyioToken });
const { account } = await adapter.authenticate();
const { items } = await adapter.listResources();
const res = await adapter.executeAction({ action: 'sql.run', resourceId: items[0].id, params: { query: 'select now()' } });
const stop = adapter.subscribe((e) => console.log(e));
// ...later: stop();
```

## Run / test

```bash
# from apps/platform-api
npm run start:dev                       # serves /_codefyio/* alongside the API
npx jest codefyio                       # adapter unit tests
curl http://localhost:4000/_codefyio/health   # {"status":"ok","version":"1.0.0"}
```

Tests cover: health, auth-exchange (valid + tampered/forged token → 401), a
`listResources`, a `sql.run` action, and rejection of a non-whitelisted action.
