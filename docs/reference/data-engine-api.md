# Data Engine API (`/api/v1/projects/:projectId`)

The Data Engine stores *entities* — schema-flexible JSON documents with a declared field list
— in a document store chosen by the operator: MongoDB, Couchbase, CouchDB, or JSONB tables in
PostgreSQL. It is optional: with `DATA_ENGINE_PROVIDER=disabled` (the compose default) every
route below answers 503.

## Authentication

Service key (`apikey`) or a dashboard session; the anon key is refused — except the health
route, which any key may call.

## Entities and records

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/v1/projects/:projectId/entities` | service | list entity definitions |
| POST | `/api/v1/projects/:projectId/entities` | service | define an entity |
| GET | `/api/v1/projects/:projectId/entities/:entity` | service | one definition (404 `Entity "<name>" not found`) |
| POST | `/api/v1/projects/:projectId/data/:entity` | service | create a record |
| GET | `/api/v1/projects/:projectId/data/:entity` | service | query records |
| GET | `/api/v1/projects/:projectId/data/:entity/:id` | service | one record |
| PATCH | `/api/v1/projects/:projectId/data/:entity/:id` | service | merge fields |
| PUT | `/api/v1/projects/:projectId/data/:entity/:id` | service | replace |
| DELETE | `/api/v1/projects/:projectId/data/:entity/:id` | service | delete (204) |
| GET | `/api/v1/projects/:projectId/data-engine/health` | anon | `{ available, reachable }` |

Entity definition body:

```json
{ "logicalName": "orders", "displayName": "Orders", "fields": [ … ], "rules": [ … ], "description": "…", "generatedByAI": false, "aiPrompt": "…" }
```

`logicalName` and `displayName` are required (400). The stored definition is
`{ id, logicalName, displayName, storageStrategy, schemaVersion, fields, generatedByAI, description? }`.

Querying `GET data/:entity` takes JSON-encoded parameters `filter` (an object matched against
the document), `sort` (`{ "path": "createdAt", "direction": "desc" }`), `limit` (1 to 1000), `offset` or `cursor` (the `nextCursor` of the previous page; not both), and
returns a page `{ data, total, hasMore, nextCursor? }`. A `limit`, `offset` or `cursor` that is not a whole number in range is a `400`. Records with equal sort values come back in a stable order (the id breaks ties), so paging never repeats or skips one. Document size, nesting depth and array length
are bounded by `DATA_ENGINE_MAX_DOC_KB` (1024), `DATA_ENGINE_MAX_NESTING_DEPTH` (8) and
`DATA_ENGINE_MAX_ARRAY_ITEMS` (1000).

## Vectors

Users can store vector embeddings alongside operational document data in MongoDB: each record of
an entity can carry one vector next to its fields, and the entity can be searched by similarity.
Available when the operator runs the Data Engine on MongoDB (`DATA_ENGINE_PROVIDER=mongodb`);
every other provider answers `501 VECTOR_NOT_SUPPORTED`. Service key or a dashboard session only,
like the record routes.

An entity's vectors come from one of two places, its **mode**:

- **`client`** — you compute the vectors with the model of your choice and send them. The platform
  never calls an embedding model for these entities, so nothing about plans, keys or the AI switch
  applies.
- **`platform`** — the platform computes each record's vector from the text at the entity's
  `sourcePaths`, with the project's embedding model (the same provider the
  [embeddings API](./embeddings-api.md) uses). You never send a vector.

**How a vector is stored.** The vector is kept in the same MongoDB document as the record, beside
its fields (never inside them), as packed float32 values with its width and the time it was
written. It is scaled to unit length when written, so a vector read back has the same direction
but not necessarily the same numbers you sent. It is never part of a record read: `GET`, list,
`PATCH`, `PUT` and aggregation results do not contain it, and writing a vector does not change
the record's `_version` (ETag), `_eventSequence` or `_updatedAt`. Updating or replacing the
record's fields keeps its vector; in client mode you re-send the vector when the text it was
computed from changes (platform mode does this for you, see below). A soft-deleted record keeps its
vector but is never a search hit; restoring the record makes it searchable again.

An entity stores vectors only after its vector config is set. Until then nothing about the
entity changes, and vector writes and searches answer `409 VECTOR_CONFIG_MISSING`.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| PUT | `/api/v1/projects/:projectId/entities/:entity/vector-config` | service | `{ "mode": "client", "dimensions": 1536 }` or `{ "mode": "platform", "sourcePaths": ["title", "body"] }` — turn vectors on or change the setup; `?purge=true` deletes existing vectors first |
| GET | `/api/v1/projects/:projectId/entities/:entity/vector-config` | service | `{ mode, dimensions, updatedAt }`, in platform mode also `sourcePaths` and `modelTag` (404 when none) |
| DELETE | `/api/v1/projects/:projectId/entities/:entity/vector-config` | service | turn vectors off; `?purge=true` is required when vectors exist and deletes them all |
| GET | `/api/v1/projects/:projectId/entities/:entity/vector-status` | service | counts, model, pending work and re-embed progress (below) |
| POST | `/api/v1/projects/:projectId/entities/:entity/reembed` | service | platform mode: re-embed every record with the project's current model (202) |
| PUT | `/api/v1/projects/:projectId/data/:entity/:id/vector` | service | client mode: `{ "vector": [0.12, -0.03, …] }` — set or replace the record's vector |
| GET | `/api/v1/projects/:projectId/data/:entity/:id/vector` | service | `{ id, dims, model, source, hash, updatedAt, vector }` (the stored, unit-length vector) |
| DELETE | `/api/v1/projects/:projectId/data/:entity/:id/vector` | service | remove the record's vector (204) |
| POST | `/api/v1/projects/:projectId/data/:entity/vectors` | service | client mode: `{ "items": [ { "id": "…", "vector": [ … ] } ] }` — up to 100; answers `{ written, missing }` |
| POST | `/api/v1/projects/:projectId/data/:entity/search` | service | nearest records to a vector or a text query (200) |

**Client mode.** `dimensions` is the width every vector of the entity must have, 1 to 2048.
Changing it while vectors exist is a `409`: send it with `?purge=true` (or delete the config with
`?purge=true`) first. In a batch write, ids with no live record in the entity are listed in
`missing` and nothing is written for them; an invalid vector fails the whole batch before
anything is written.

**Platform mode.** `sourcePaths` names 1 to 8 fields under the record's data, as dot paths
(`"title"`, `"body.text"`; the same characters as filter paths, no `[]` and no segment starting
with `$`). The text of a record is the value at each path in the order given, joined with a line
break: strings as they are, numbers, booleans, arrays and objects as JSON text; missing fields,
`null` and empty strings are skipped. Text longer than 24 000 characters is cut. A record whose
text is empty has no vector and is not a search hit. `dimensions` is not sent: it comes from the
project's embedding model, which must produce at most 2048 dimensions (`400 VECTOR_MODEL_TOO_WIDE`
otherwise), and is stored with the model's tag (`modelTag`, e.g. `openai/text-embedding-3-small`).

```json
PUT /api/v1/projects/:projectId/entities/articles/vector-config
{ "mode": "platform", "sourcePaths": ["title", "body"] }
→ { "mode": "platform", "dimensions": 1536, "sourcePaths": ["title", "body"],
    "modelTag": "openai/text-embedding-3-small", "updatedAt": "…", "reembed": { "queued": true, "total": 812 } }
```

- After every create, update, replace or restore of a record, its vector is computed in the
  background, never inside your request; the write answers as fast as before. A burst of writes
  to one record is embedded once. The text's sha256 is stored with the vector (`hash`), so a write
  that does not change the text of the source fields costs no embedding. A delete needs nothing:
  the record leaves search with its record.
- Records that exist when platform mode is set are embedded by a re-embed job (`reembed.queued`).
- Changing `sourcePaths` re-embeds the entity with the new text; sending the same paths changes
  nothing. Switching from client to platform mode, or back, while vectors exist needs
  `?purge=true` (they come from different models). While a re-embed runs, changing the paths is a
  `409 VECTOR_REEMBED_RUNNING`.
- You cannot send vectors to a platform-mode entity (`409 VECTOR_MODE_PLATFORM`).
- **Model change.** When the project's embedding model changes
  (`PUT /api/projects/:projectId/embeddings/provider`), nothing is re-embedded automatically.
  `vector-status` shows `mismatch: true`, and a text search answers `409 VECTOR_MODEL_MISMATCH`
  until you call `POST .../entities/:entity/reembed` and it finishes; the entity then holds the new
  model's vectors, width and `modelTag`. Vector searches (`vector` in the body) keep working.
- Platform mode follows the same rules as the embeddings API: `AI_ENABLED=false` → `403
  AI_DISABLED`; no key for the provider → `400`; on the platform's key the team needs the Pro plan
  or above (`403 EMBEDDING_PLAN_REQUIRED`, also at `PUT vector-config` so you learn it at set-up)
  and the project has a daily token limit (`429 EMBEDDING_DAILY_LIMIT`), shared with the
  embeddings API — see [Plans and the daily limit](./embeddings-api.md#plans-and-the-daily-limit).
  A project with its own provider key is never gated or limited.

Re-embed and status:

```json
POST /api/v1/projects/:projectId/entities/articles/reembed
→ 202 { "queued": true, "total": 812, "reembed": { "status": "QUEUED", "done": 0, "total": 812, "failed": 0, … } }

GET /api/v1/projects/:projectId/entities/articles/vector-status
→ { "mode": "platform", "dimensions": 1536, "embedded": 806, "total": 812, "pending": 4, "failed": 2,
    "modelTag": "openai/text-embedding-3-small", "currentModelTag": "openai/text-embedding-3-small",
    "mismatch": false, "sourcePaths": ["title", "body"], "maxScan": 10000, "strategy": "exact",
    "reembed": { "status": "COMPLETED", "done": 812, "total": 812, "failed": 2, "model": "…",
                 "dimensions": 1536, "lastError": "…", "startedAt": "…", "updatedAt": "…", "finishedAt": "…" },
    "platformKeyAllowed": true,
    "dailyTokens": { "limit": 1000000, "used": 48210, "resetsAt": "2026-11-29T00:00:00.000Z" } }
```

- `pending` — live records still waiting for a vector of the current model (new or changed
  records whose job has not run yet, records of an older model). `failed` — records whose last
  embedding failed (the provider rejected their text, for example); they are tried again on their
  next write or re-embed. Both are `null` in client mode.
- `reembed` — the last run: `QUEUED`, `RUNNING`, `COMPLETED` or `FAILED`, records done out of
  `total`, how many failed, and the last error (never a key). A run reads 100 records at a time,
  skips records whose text and model did not change, and counts a record that fails without
  stopping. It stops as `FAILED` when the provider, the plan, the AI switch or the daily limit
  refuses (it never retries on its own): fix the cause and start it again. A second `reembed`
  while one runs is a `409 VECTOR_REEMBED_RUNNING`; a run that has not reported for 10 minutes is
  considered dead and a new one may start.
- `platformKeyAllowed` — whether this project may compute embeddings now (its own key, or the
  platform's key on Pro and above). `dailyTokens` — the platform-key limit, today's use and when it
  resets (UTC); `null` on the project's own key.

Search:

```json
POST /api/v1/projects/:projectId/data/:entity/search
{ "vector": [0.12, -0.03, …], "filter": { "kind": "faq", "lang": "en" }, "limit": 10, "threshold": 0.5 }
{ "query": "waterproof hiking boots", "filter": { "lang": "en" }, "limit": 5 }
```

- Exactly one of `vector` or `query`.
- `vector` — same width as the entity's `dimensions`.
- `query` — text, at most 8000 characters; platform-mode entities only. It is embedded with the
  entity's model and counts against the project's daily embedding limit. On a client-mode entity
  it is a `400 VECTOR_QUERY_NEEDS_PLATFORM_MODE`: the stored vectors come from your model, and a
  query embedded with the platform's model could not be compared with them.
- `filter` — optional, the same grammar as the list route's `filter` (`{ "age": { "$gt": 3 } }`,
  `$and`, `$or`, …), applied before scoring.
- `limit` — 1 to 100, default 10.
- `threshold` — maximum cosine distance, 0 to 2, default 0.5. Only records closer than this are
  returned.

```json
{ "data": [ { "_id": "…", "kind": "faq", "…": "…", "_distance": 0.12, "_score": 0.88 } ], "scanned": 840, "strategy": "exact" }
```

`data` holds full records, closest first, each with `_distance` (cosine distance, 0 = same
direction, 2 = opposite) and `_score` (`1 - _distance`). `scanned` is the number of vectors
compared.

**Exact search and its limit.** Search compares the query with every candidate vector (the live
records of the entity that match `filter` and have a vector), so results are exact. One search
compares at most `DATA_ENGINE_VECTOR_MAX_SCAN` vectors (10 000 by default). When more records are
candidates, the search is refused with `422 VECTOR_SCAN_LIMIT`; it never returns results from a
part of the entity. Narrow it with a `filter` (a category, a tenant field, a date range) so that
fewer records are candidates. One search also has a server-side time limit,
`DATA_ENGINE_VECTOR_TIMEOUT_MS` (5 000 ms), and each API process runs at most 4 searches at a
time; above that a search answers `429` and can be retried.

**Backups.** The document store is not yet covered by the platform's backups. Keep the vectors you
send reproducible on your side (the source text and the model you used), so you can write them
again. Platform-mode vectors can be recomputed from the records with `reembed`.

Errors of the vector routes:

| Status | Code | When |
|---|---|---|
| 400 | `VECTOR_DIMENSION_MISMATCH` | the vector's width differs from the entity's `dimensions` |
| 400 | `VECTOR_INVALID` | not an array of finite numbers, or all zeros |
| 400 | `VECTOR_QUERY_NEEDS_PLATFORM_MODE` | a text `query` on a client-mode entity |
| 400 | `VECTOR_MODEL_TOO_WIDE` | platform mode with a model wider than 2048 dimensions |
| 400 | | malformed `filter`, `limit` or `threshold` out of range, more than 100 items; both or neither of `vector` and `query`; invalid `sourcePaths`; `dimensions` in platform mode; no key for the provider |
| 403 | `AI_DISABLED` | platform mode, text search or re-embed while `AI_ENABLED=false` |
| 403 | `EMBEDDING_PLAN_REQUIRED` | platform mode, text search or re-embed on the platform's key below the Pro plan |
| 404 | `DOCUMENT_NOT_FOUND` | no live record with this id in this entity of this project |
| 409 | `VECTOR_CONFIG_MISSING` | a vector write or search on an entity without a vector config |
| 409 | `VECTOR_MODE_PLATFORM` | sending vectors to a platform-mode entity |
| 409 | `VECTOR_MODEL_MISMATCH` | a text search after the project's model changed; re-embed first |
| 409 | `VECTOR_REEMBED_RUNNING` | a re-embed is already running; changing `sourcePaths` during one |
| 409 | `VECTOR_MODE_NOT_PLATFORM` | `reembed` on a client-mode entity |
| 409 | | changing `dimensions` or the mode while vectors exist without `?purge=true`; deleting the config without `?purge=true` |
| 422 | `VECTOR_SCAN_LIMIT` | more candidates than `DATA_ENGINE_VECTOR_MAX_SCAN`: add a `filter` |
| 429 | `VECTOR_SEARCH_BUSY` | too many searches running on this API process; retry |
| 429 | `EMBEDDING_DAILY_LIMIT` | the project's daily platform-key embedding tokens are used up (text search) |
| 502 / 429 | | the embedding provider rejected the key, is unreachable or hit its own quota (text search) |
| 503 | | the re-embed job could not be queued |
| 501 | `VECTOR_NOT_SUPPORTED` | the Data Engine provider does not store vectors |
| 503 | `VECTOR_SEARCH_TIMEOUT` | the search exceeded `DATA_ENGINE_VECTOR_TIMEOUT_MS`: add a `filter` |

`GET /api/v1/projects/:projectId/data-query/capabilities` reports the provider's vector support
as `capabilities.vector`: `{ embeddings, hybridSearch, strategy, maxDimensions, maxScan }`, or
`null`.

## Queries (`/api/v1/projects/:projectId/data-query`)

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/v1/projects/:projectId/data-query/js` | service | `{ source, page?, limit? }` — run a JavaScript query against the store |
| POST | `/api/v1/projects/:projectId/data-query/aggregation` | service | `{ entity, pipeline }` — an aggregation pipeline |
| GET | `/api/v1/projects/:projectId/data-query/capabilities` | service | what the configured provider supports |
| GET | `/api/v1/projects/:projectId/data-query/saved` | service | saved queries |
| POST | `/api/v1/projects/:projectId/data-query/saved` | service | `{ name, source, entity?, mode?: 'js' \| 'aggregation' }` |
| DELETE | `/api/v1/projects/:projectId/data-query/saved/:id` | service | delete a saved query |

## Structures (`/api/v1/projects/:projectId/structures`)

The unified Data Explorer view of a project: SQL tables and JSON structures together.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/v1/projects/:projectId/structures` | service | list all structures |
| POST | `/api/v1/projects/:projectId/structures` | service | `{ name, kind: "relational" \| "json" }` — the JSON backend is chosen by the platform, never by the client |

## SDK

```ts
const orders = bf.data.collection<Order>('orders');
await orders.insert({ total: 12.5 });
const { data: page } = await orders.find({ status: 'open' }).sort('createdAt', 'desc').limit(20);
await orders.update(id, { status: 'shipped' });
const { data: health } = await bf.data.health();

await bf.data.vectorConfig('articles').set({ mode: 'platform', sourcePaths: ['title', 'body'] });
const { data: hits } = await bf.data.collection('articles').search({ query: 'waterproof boots', limit: 5 });
```

## Errors

| Status | When |
|---|---|
| 400 | `logicalName is required`; `displayName is required`; malformed `filter`/`sort` JSON |
| 403 | anon key; not a team member |
| 404 | `Entity "<name>" not found`; unknown record |
| 503 | `Data Engine is temporarily unavailable…` (provider disabled or the store is starting) |

Source: `apps/platform-api/src/modules/data-engine/data-engine.controller.ts`,
`data-vector.controller.ts`, `dto/vector.dto.ts`, `data-engine.service.ts`, `data-vector-embedder.service.ts`,
`data-vector.processor.ts`, `vector-source.ts`,
`packages/data-engine/src/providers/mongodb/mongodb-engine.ts`, `apps/platform-api/src/modules/data-query/data-query.controller.ts`,
`dto/*.ts`, `apps/platform-api/src/modules/data-structures/data-structures.controller.ts`;
SDK: `packages/sdk/src/modules/data-engine.ts`.
