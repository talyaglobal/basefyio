# Realtime API (basefyio)

basefyio uses a **per-entity opt-in** model (like Supabase publications): only the
tables/collections you **enable** broadcast `INSERT` / `UPDATE` / `DELETE` events
to connected clients. Events include full row data and are visible to anyone
holding a project API key — so enable only what your app should broadcast.

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

## 2. Subscribe to the event stream (SDK / app)

Once an entity is enabled, subscribe over SSE. `EventSource` can't send headers,
so the key goes in the query string (anon **or** service key both subscribe).

```
GET /api/realtime/v1/stream?apikey=<ANON_OR_SERVICE_KEY>&channels=table:orders,collection:carts
```
Omit `channels` to receive events for **all** enabled entities. Each SSE frame is
`data: { "type": "INSERT|UPDATE|DELETE", "kind", "entity", "record": {...} }`.

```ts
const es = new EventSource(
  `https://api.basefyio.com/api/realtime/v1/stream?apikey=${ANON_KEY}&channels=table:orders`,
);
es.onmessage = (m) => console.log(JSON.parse(m.data));
```

Or with the SDK: `bf.realtime.subscribe('table:orders', (evt) => { ... })`.

---

## 3. Where to find the keys

Project → **Connection** (or the sidebar **API Keys** box): `anon` (public,
browser-safe) and `service_role` (secret, server-only). Use the **service_role**
key for binding management (§1), and either key to subscribe (§2).

## Security notes

- Realtime broadcasts full row data to any client with a project key — only
  enable entities that are safe to broadcast to your app's users.
- Binding **writes** require the service key; reads and subscribe accept the anon key.
- Bindings are per project and isolated — a key for project A cannot touch project B.
