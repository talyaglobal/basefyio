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
every other provider answers `501 VECTOR_NOT_SUPPORTED`. The client computes the vectors with the
model of its choice and sends them; the platform does not call an embedding model for these
routes. Service key or a dashboard session only, like the record routes.

**How a vector is stored.** The vector is kept in the same MongoDB document as the record, beside
its fields (never inside them), as packed float32 values with its width and the time it was
written. It is scaled to unit length when written, so a vector read back has the same direction
but not necessarily the same numbers you sent. It is never part of a record read: `GET`, list,
`PATCH`, `PUT` and aggregation results do not contain it, and writing a vector does not change
the record's `_version` (ETag), `_eventSequence` or `_updatedAt`. Updating or replacing the
record's fields keeps its vector; the client re-sends the vector when the text it was computed
from changes. A soft-deleted record keeps its vector but is never a search hit; restoring the
record makes it searchable again.

An entity stores vectors only after its vector config is set. Until then nothing about the
entity changes, and vector writes and searches answer `409 VECTOR_CONFIG_MISSING`.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| PUT | `/api/v1/projects/:projectId/entities/:entity/vector-config` | service | `{ "mode": "client", "dimensions": 1536 }` — turn vectors on for the entity |
| GET | `/api/v1/projects/:projectId/entities/:entity/vector-config` | service | `{ mode, dimensions, updatedAt }` (404 when none) |
| DELETE | `/api/v1/projects/:projectId/entities/:entity/vector-config` | service | turn vectors off; `?purge=true` is required when vectors exist and deletes them all |
| GET | `/api/v1/projects/:projectId/entities/:entity/vector-status` | service | `{ mode, dimensions, embedded, total, maxScan, strategy }` |
| PUT | `/api/v1/projects/:projectId/data/:entity/:id/vector` | service | `{ "vector": [0.12, -0.03, …] }` — set or replace the record's vector |
| GET | `/api/v1/projects/:projectId/data/:entity/:id/vector` | service | `{ id, dims, model, source, updatedAt, vector }` (the stored, unit-length vector) |
| DELETE | `/api/v1/projects/:projectId/data/:entity/:id/vector` | service | remove the record's vector (204) |
| POST | `/api/v1/projects/:projectId/data/:entity/vectors` | service | `{ "items": [ { "id": "…", "vector": [ … ] } ] }` — up to 100; answers `{ written, missing }` |
| POST | `/api/v1/projects/:projectId/data/:entity/search` | service | nearest records to a vector (200) |

`mode` is `"client"` (the client sends the vectors). `dimensions` is the width every vector of the
entity must have, 1 to 2048. Changing it while vectors exist is a `409`: delete the config with
`?purge=true` first. In a batch write, ids with no live record in the entity are listed in
`missing` and nothing is written for them; an invalid vector fails the whole batch before
anything is written.

Search:

```json
POST /api/v1/projects/:projectId/data/:entity/search
{ "vector": [0.12, -0.03, …], "filter": { "kind": "faq", "lang": "en" }, "limit": 10, "threshold": 0.5 }
```

- `vector` — same width as the entity's `dimensions`.
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
again.

Errors of the vector routes:

| Status | Code | When |
|---|---|---|
| 400 | `VECTOR_DIMENSION_MISMATCH` | the vector's width differs from the entity's `dimensions` |
| 400 | `VECTOR_INVALID` | not an array of finite numbers, or all zeros |
| 400 | | malformed `filter`, `limit` or `threshold` out of range, more than 100 items |
| 404 | `DOCUMENT_NOT_FOUND` | no live record with this id in this entity of this project |
| 409 | `VECTOR_CONFIG_MISSING` | a vector write or search on an entity without a vector config |
| 409 | | changing `dimensions` while vectors exist; deleting the config without `?purge=true` |
| 422 | `VECTOR_SCAN_LIMIT` | more candidates than `DATA_ENGINE_VECTOR_MAX_SCAN`: add a `filter` |
| 429 | `VECTOR_SEARCH_BUSY` | too many searches running on this API process; retry |
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
const orders = bf.data.entity<Order>('orders');
await orders.insert({ total: 12.5 });
const { data: page } = await orders.find({ status: 'open' }).sort('createdAt', 'desc').limit(20);
await orders.update(id, { status: 'shipped' });
const { data: health } = await bf.data.health();
```

## Errors

| Status | When |
|---|---|
| 400 | `logicalName is required`; `displayName is required`; malformed `filter`/`sort` JSON |
| 403 | anon key; not a team member |
| 404 | `Entity "<name>" not found`; unknown record |
| 503 | `Data Engine is temporarily unavailable…` (provider disabled or the store is starting) |

Source: `apps/platform-api/src/modules/data-engine/data-engine.controller.ts`,
`data-vector.controller.ts`, `dto/vector.dto.ts`, `data-engine.service.ts`,
`packages/data-engine/src/providers/mongodb/mongodb-engine.ts`, `apps/platform-api/src/modules/data-query/data-query.controller.ts`,
`dto/*.ts`, `apps/platform-api/src/modules/data-structures/data-structures.controller.ts`;
SDK: `packages/sdk/src/modules/data-engine.ts`.
