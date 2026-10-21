# Realtime API (basefyio)

basefyio realtime has three parts, all served over one Server-Sent Events
stream per client:

- **Data changes** — `INSERT` / `UPDATE` / `DELETE` events for the tables and
  collections you **enable** (per-entity opt-in). Nothing broadcasts until you
  enable it.
- **Presence** — who is on a channel right now (join / leave / sync).
- **Broadcast** — messages from one client to the others on a channel, without a
  database round trip.

Several API instances can serve the same project: events are fanned out through
Redis, and each subscriber receives every event exactly once.

There are **three ways** to enable/disable realtime on a table or collection:

1. **Dashboard UI** — project → **Realtime** (its own page) → toggle per entity.
2. **Service-key REST API** — for SDK clients and **agents that only hold a
   project API key** (no dashboard login). ← this is what you want for automation.
3. **Codefyio adapter actions** — `realtime.list` / `realtime.set` (for agents
   driving the product from the Codefyio IDE). See [CODEFYIO_ADAPTER.md](./CODEFYIO_ADAPTER.md).

---

## 1. Manage bindings from an agent (service-key REST API)

Base: `https://api.basefyio.com` · the **API key identifies the project** (sent as
the `apikey` header), so there is no project id in the path.

| Method | Path | Key | Purpose |
|--------|------|-----|---------|
| GET | `/api/rest/v1/realtime/bindings` | anon **or** service | List current bindings (which entities broadcast). |
| PUT | `/api/rest/v1/realtime/bindings` | **service_role** | Enable/disable realtime for one entity. |

> Changing bindings is a privileged operation → it requires the project's
> **service_role** key (`kb_service_...`), not the anon key. Reading is allowed
> with either key. Keep the service key server-side / in the agent's secrets.

### List enabled entities
```bash
curl -s https://api.basefyio.com/api/rest/v1/realtime/bindings \
  -H "apikey: $SERVICE_KEY"
# → [ { "kind": "table", "entity": "orders", "createdAt": "..." }, ... ]
```

### Enable realtime on a table
```bash
curl -s -X PUT https://api.basefyio.com/api/rest/v1/realtime/bindings \
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \
  -d '{ "kind": "table", "entity": "orders", "enabled": true }'
```

### Disable it again
```bash
curl -s -X PUT https://api.basefyio.com/api/rest/v1/realtime/bindings \
  -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \
  -d '{ "kind": "table", "entity": "orders", "enabled": false }'
```

**Body:** `{ kind: "table" | "collection", entity: string, enabled: boolean }`.
`entity` must match `^[A-Za-z_][A-Za-z0-9_]*$` (the table/collection name).

**Errors:** `401` invalid/missing key · `403` non-service key on PUT ·
`400` bad `kind`/`entity`.

### Node example (agent)
```ts
const BASE = 'https://api.basefyio.com/api/rest/v1/realtime/bindings';
const headers = { apikey: process.env.BASEFYIO_SERVICE_KEY!, 'Content-Type': 'application/json' };

// turn realtime ON for a table
await fetch(BASE, { method: 'PUT', headers, body: JSON.stringify({ kind: 'table', entity: 'orders', enabled: true }) });

// see what's enabled
const bindings = await (await fetch(BASE, { headers })).json();
```

---

## 2. The event stream

```
GET /api/realtime/v1/stream
```

| Input | Where | Notes |
|-------|-------|-------|
| anon key | `apikey` header **or** `?apikey=` | The query form exists because `EventSource` cannot set headers. |
| service key | `apikey` header only | **Refused in the query string** (a URL reaches access logs, browser history and Referer headers). A server may subscribe with it in the header; it then sees every row. |
| user access token | `Authorization: Bearer <jwt>` **or** `?access_token=<jwt>` | Verified against the project's own realm, exactly like `rest/v1`. An invalid token is refused (`401`). |
| `channels` | query | Comma list of `table:<name>`, `collection:<name>`, `broadcast:<name>`. Omit for every enabled entity. |
| `presence` | query | A member key (`^[A-Za-z0-9_.:@-]{1,128}$`) or `auto` for the signed-in user's id. Requires explicit `channels`. |
| `presence_meta` | query | JSON object (≤ 1 KB) shown to the other members. |

Frames, as SSE `event:` names:

| event | data |
|-------|------|
| `ready` | `{ subscriptionId, channels, role, presence? }` — first frame; `role` is `anon`, `authenticated` or `service_role`. |
| `data_change` | `{ eventId, type, kind, entity, new, old, commitTimestamp }` |
| `presence` | `{ type: "join" \| "leave" \| "sync", channel, key?, meta?, members?, at }` |
| `broadcast` | `{ eventId, channel, event, payload, sender: { role, sub? }, sentAt }` |
| `ping` | `{ t }` every 25 s |

```ts
const es = new EventSource(
  `https://api.basefyio.com/api/realtime/v1/stream?apikey=${ANON_KEY}&channels=table:orders`,
);
es.addEventListener('data_change', (m) => console.log(JSON.parse(m.data)));
```

### Row-level security on the stream

A change event carries the whole row. For a table **with row-level security
enabled**, the API re-selects the changed row under each subscriber's role and
claims — the same `SET LOCAL ROLE` + `request.jwt.claims` the REST data plane
uses — and delivers the event only to subscribers who may read that row:

- a **signed-in user** (anon key + access token) receives only rows their
  policies allow;
- a **service-key** subscriber receives everything;
- a `DELETE` on such a table carries only the primary key columns (a deleted row
  cannot be re-checked);
- a table with RLS but **no primary key** cannot be checked, so its events reach
  service-key subscribers only (the API logs a warning naming the table).

A table **without RLS** is delivered to every subscriber, unchanged.

The scope of the check is set by `REALTIME_RLS_FILTER` on the server:

| value | meaning |
|-------|---------|
| `jwt` (default) | Subscribers that presented an access token are filtered; anon subscribers are not. |
| `all` | Anon subscribers are filtered too, under the `anon` role — stricter opt-in. |
| `off` | No filtering. |

---

## 3. Presence

Join with `presence=<key>` (or `presence=auto` with an access token). Everyone on
the channel — members or not — receives `join` and `leave`; the joiner alone
receives a `sync` with the current member list. A member with several
connections (two tabs) joins once and leaves when the last connection closes.
Members whose heartbeats stop are announced as gone after
`REALTIME_PRESENCE_TTL_SEC` (default 90 s).

```bash
curl -N "https://api.basefyio.com/api/realtime/v1/stream?apikey=$ANON_KEY&channels=broadcast:room-1&presence=alice&presence_meta=%7B%22color%22%3A%22red%22%7D"
# event: ready     data: {"subscriptionId":"…","channels":["broadcast:room-1"],"role":"anon","presence":"alice"}
# event: presence  data: {"type":"sync","channel":"broadcast:room-1","members":[{"key":"alice","meta":{"color":"red"},"lastSeen":…}],"at":"…"}
```

---

## 4. Broadcast between clients

```
POST /api/realtime/v1/broadcast
apikey: <anon or service key>
Authorization: Bearer <access token>   (optional)
{ "channel": "room-1", "event": "cursor", "payload": { "x": 1, "y": 2 }, "from": "<own subscriptionId>" }
```

Delivered as a `broadcast` frame to every subscriber of `broadcast:room-1` on
any instance. No database is involved. `from` is the sender's own subscription
id, so the sender does not receive its own message.

| Status | Meaning |
|--------|---------|
| `202` | `{ ok: true, eventId }` — accepted and fanned out |
| `400` | bad `channel` (`^[A-Za-z0-9_.:-]{1,128}$`), `event` (`^[A-Za-z0-9_.:-]{1,64}$`) or `from` |
| `413` | payload above `REALTIME_BROADCAST_MAX_BYTES` (default 64 KB) |
| `429` | more than `REALTIME_BROADCAST_RATE_PER_MIN` (default 600) from one sender, or `REALTIME_BROADCAST_PROJECT_RATE_PER_MIN` (default 6000) for the project |
| `403` | the deployment requires a signed-in user (`REALTIME_BROADCAST_REQUIRE_JWT=1`) |

A sender is the signed-in user when a token is present, otherwise the client
address. The service key is exempt from the per-sender limit.

---

## 5. JS SDK

```ts
import { createClient } from 'basefyio-js';
const bf = createClient({ projectId, apiKey });

// Data changes (unchanged API). With a signed-in user the stream carries the
// user's token as a header, so row-level security applies to what arrives.
const sub = bf.realtime.subscribe({ table: 'orders', event: 'INSERT' }, (c) => console.log(c.new));
sub.unsubscribe();

// A channel: presence + broadcast (+ optional data changes) on one connection.
const room = bf.realtime
  .channel('room-1', { presenceKey: 'auto', presenceMeta: { color: 'red' } })
  .on('presence', { event: 'sync' }, () => render(room.presenceState()))
  .on('presence', { event: 'join' }, (p) => console.log('joined', p.key))
  .on('broadcast', { event: 'cursor' }, (msg) => draw(msg.payload))
  .on('data_change', { table: 'orders' }, (c) => refresh(c));
await room.subscribe();
await room.send({ event: 'cursor', payload: { x: 1, y: 2 } });
await room.track({ color: 'blue' });   // update presence metadata
room.unsubscribe();
```

Transport is chosen automatically: without a signed-in user the SDK uses the
platform `EventSource` with the anon key in the URL (as before); with a user it
reads the stream over `fetch` so the key and token travel as headers. Pass
`transport: 'eventsource'` or `'fetch'` to `new RealtimeClient(url, key, opts)`
to force one.

---

## 6. Server configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `REALTIME_FANOUT` | `redis` | `redis` fans events out across API instances through Redis pub/sub; `off` keeps delivery process-local. Falls back to local delivery when Redis is unreachable. |
| `REALTIME_RLS_FILTER` | `jwt` | `jwt` filters subscribers that presented an access token; `all` filters anon subscribers too; `off` disables filtering. |
| `REALTIME_RLS_META_TTL_MS` | `60000` | Cache lifetime of the per-table "RLS enabled + primary key" lookup. |
| `REALTIME_PRESENCE_TTL_SEC` | `90` | Presence member expiry once heartbeats stop. |
| `REALTIME_BROADCAST_MAX_BYTES` | `65536` | Maximum serialized broadcast payload. |
| `REALTIME_BROADCAST_RATE_PER_MIN` | `600` | Broadcasts per minute per sender per project. |
| `REALTIME_BROADCAST_PROJECT_RATE_PER_MIN` | `6000` | Broadcasts per minute per project; `0` disables broadcast. |
| `REALTIME_BROADCAST_REQUIRE_JWT` | `0` | `1` refuses broadcasts from a bare anon key without a signed-in user. |

Writes made through `rest/v1`, collections, the dashboard table editor and the
Codefyio adapter produce events. Writes made with raw SQL outside the platform
do not: the stream is fed by the API layer, not by the write-ahead log.

## 7. Where to find the keys

Project → **Connection** (or the sidebar **API Keys** box): `anon` (public,
browser-safe) and `service_role` (secret, server-only). Use the **service_role**
key for binding management (§1) and the anon key — with the user's access token
when there is one — to subscribe and broadcast.

## Security notes

- Enable an entity only if its rows may reach every subscriber the policy allows:
  a table **without** RLS broadcasts every row to any key holder.
- Binding **writes** require the service key; reads, subscribe and broadcast
  accept the anon key.
- The service key is never accepted from a URL.
- Bindings are per project and isolated — a key for project A cannot touch project B.
