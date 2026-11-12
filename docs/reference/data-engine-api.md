# Data Engine API (`/api/v1/projects/:projectId`)

The Data Engine stores *entities* — JSON documents with an optional declared field list — in a
document store chosen by the operator: MongoDB, Couchbase, CouchDB, or JSONB tables in
PostgreSQL. It is optional: with `DATA_ENGINE_PROVIDER=disabled` (the compose default) every
document route answers 503.

Entities are not the same thing as JSON collections (`collections-api.md`): collections are
tables in the project's own database, reachable with the anon key under row-level security;
entities live in the Data Engine store, are reachable with the service key only, and add
field validation, versions, `If-Match` and recoverable deletes. Nothing is shared or synced
between the two. Calling `/data/:entity` with the name of a collection answers 404 with the
collection route to use.

## Authentication

Service key (`apikey`) or a dashboard session; the anon key is refused (403) — except the
health route, which any key may call. The engine runs with owner rights and no policies, so
call it from a server.

## Entities

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/v1/projects/:projectId/entities` | service | list entity definitions; `?withCounts=true` adds `documentCount` |
| POST | `/api/v1/projects/:projectId/entities` | service | define an entity (409 if the name — compared without case and punctuation — exists) |
| GET | `/api/v1/projects/:projectId/entities/:entity` | service | one definition (404 `Entity "<name>" not found`) |
| PATCH | `/api/v1/projects/:projectId/entities/:entity` | service | `{ displayName?, description?, fields?, rules? }`; a field change publishes schema version n+1 |
| DELETE | `/api/v1/projects/:projectId/entities/:entity` | service | 409 `ENTITY_NOT_EMPTY` while documents (deleted ones included) exist; `?force=true` removes them permanently |

Entity definition body:

```json
{ "logicalName": "orders", "displayName": "Orders", "fields": [ … ], "rules": [ … ], "description": "…" }
```

`logicalName` and `displayName` are required (400). `fields` is optional; each field is
`{ name, kind, type?, required?, children?, itemSchema?, validationRules? }` with `kind` one of
`scalar | object | array | lookup | relation | attachment | media | computed | counter |
localizedText | viewerState | syncState` and scalar `type` one of `text | longText | number |
currency | boolean | date | datetime | email | phone | url | json | multiLookup`. Missing
`required`/`unique`/`indexed`/`validationRules`/`displayName` are filled in; an invalid list is a
400 `INVALID_ENTITY_DEFINITION` and nothing is written (the definition, its first schema version
and the outbox row are created in one transaction).

## Documents

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/v1/projects/:projectId/data/:entity` | service | create one document; an array (≤ 1000) inserts each — all validated before any is written |
| GET | `/api/v1/projects/:projectId/data/:entity` | service | query a page |
| GET | `/api/v1/projects/:projectId/data/:entity/count` | service | `{ count }` for `?filter=` (and `includeSoftDeleted`) |
| GET | `/api/v1/projects/:projectId/data/:entity/:id` | service | one document; `?includeSoftDeleted=true` also finds deleted ones; `ETag` = version |
| PATCH | `/api/v1/projects/:projectId/data/:entity/:id` | service | shallow merge: each top-level field sent replaces that field |
| PUT | `/api/v1/projects/:projectId/data/:entity/:id` | service | replace the document |
| DELETE | `/api/v1/projects/:projectId/data/:entity/:id` | service | soft delete (204) |
| POST | `/api/v1/projects/:projectId/data/:entity/:id/restore` | service | undo a soft delete (409 `DOCUMENT_NOT_DELETED` otherwise) |
| GET | `/api/v1/projects/:projectId/data-engine/health` | anon | `{ available, reachable }` |

### Query parameters (`GET data/:entity`)

| Parameter | Accepted forms |
|---|---|
| `filter` | document form `{"status":"active","total":{"$gte":10},"$or":[…]}`; the AST form `{"type":"field","path":{"path":"grp"},"operator":"eq","value":"g1"}` / `{"type":"and"\|"or","conditions":[…]}` / `{"type":"not","condition":…}` keeps working |
| `sort` | `[{"path":"_createdAt","direction":"desc"}]`, `[{"path":{"path":"_createdAt"},"direction":"desc"}]`, `{"path":"…","direction":"…"}`, `{"_createdAt":-1}` or `-_createdAt,name`; max 5 fields; an unknown direction is a 400 |
| `select` | `name,address.city` (or a JSON array / `{"name":1}`); the envelope is always returned |
| `limit` | 1–1000, default 50; larger values are capped at 1000; `0`, negative or non-numeric is a 400 |
| `offset` / `cursor` | `cursor` is the `nextCursor` of the previous page and wins over `offset` |
| `includeSoftDeleted` | `true` also returns deleted documents |

Filter operators: `$eq $ne $gt $gte $lt $lte $in $nin $contains $containsAny $exists $regex
$iregex $like $ilike`, and `$and $or $not`. Equality on an array field matches an element.
Dotted paths address nested fields; a nested object as a value is rejected (use the dotted path).
Without `sort` the order is newest first; `_id` breaks ties so pages are stable.
The response is `{ data, total, hasMore, nextCursor? }`.

### Writes

- The body must be a JSON object (an array only on `POST`, for bulk insert). Envelope fields
  (`_id`, `_version`, …) in a body are ignored.
- When the entity has fields, create and replace must satisfy them (required, types, nested
  objects, array items, validation rules); `PATCH` checks the fields it sends and refuses
  `null` for a required field. Violations: 422 `SCHEMA_VALIDATION_FAILED`, listing each path.
  Stored documents are never re-validated on read. `DATA_ENGINE_SCHEMA_VALIDATION=off`
  disables the field checks.
- Limits: `DATA_ENGINE_MAX_DOC_KB` (1024) → 413 `DOCUMENT_TOO_LARGE`;
  `DATA_ENGINE_MAX_NESTING_DEPTH` (8 nested objects/arrays) and `DATA_ENGINE_MAX_ARRAY_ITEMS`
  (1000) → 422 `DOCUMENT_LIMIT_EXCEEDED`.
- Concurrency: send the version you read as `If-Match: "4"` (also `4` or `W/"4"`) on PATCH,
  PUT, DELETE or restore; a newer version is a 409 `CONCURRENCY_CONFLICT` and nothing changes.
  The check is part of the write itself, so two concurrent writers cannot both win.

## Views (`/api/v1/projects/:projectId/views`)

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/v1/projects/:projectId/views/:name` | service | run the saved query `name` and return `{ data, total, hasMore, nextCursor? }`; `limit`, `offset`, `cursor` page a JS query |

## Queries (`/api/v1/projects/:projectId/data-query`)

| Method | Path | Tier | Purpose |
|---|---|---|---|
| POST | `/api/v1/projects/:projectId/data-query/js` | service | `{ source, page?, limit? }` — run a JavaScript query against an entity or a JSON collection |
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
await orders.insertMany([{ total: 1 }, { total: 2 }]);
const { data: page } = await orders.find({ status: 'open' }).sort('_createdAt', 'desc').limit(20);
const { data: n } = await orders.count({ status: 'open' });
await orders.update(id, { status: 'shipped' }, { ifMatch: 3 });
await orders.restore(id);
const { data: feed } = await bf.data.view('openOrders', { limit: 20 });
const { data: health } = await bf.data.health();
```

## Errors

Bodies are `{ statusCode, message, code? }`.

| Status | When |
|---|---|
| 400 | `logicalName is required`; `displayName is required`; invalid `filter`/`sort`/`select`/`limit`/`If-Match`; a body that is not a JSON object; `INVALID_ENTITY_DEFINITION` |
| 403 | anon key; not a team member |
| 404 | `ENTITY_NOT_FOUND` (with the collections route as a hint); `DOCUMENT_NOT_FOUND` (also for writes to missing or deleted documents) |
| 409 | `CONCURRENCY_CONFLICT`; `ENTITY_EXISTS`; `ENTITY_NOT_EMPTY`; `DOCUMENT_NOT_DELETED` |
| 413 | `DOCUMENT_TOO_LARGE` |
| 422 | `SCHEMA_VALIDATION_FAILED`; `DOCUMENT_LIMIT_EXCEEDED` |
| 429 | more than 300 requests per minute from one client |
| 500 | `DATA_ENGINE_ERROR` — an unexpected store failure; no internal detail is returned |
| 503 | `Data Engine is temporarily unavailable…` (provider disabled or the store is starting) |

Source: `apps/platform-api/src/modules/data-engine/data-engine.controller.ts`,
`data-engine.service.ts`, `data-engine-http.util.ts`,
`apps/platform-api/src/modules/data-query/data-query.controller.ts`, `data-views.controller.ts`,
`dto/*.ts`, `apps/platform-api/src/modules/data-structures/data-structures.controller.ts`;
`packages/data-engine/src/query/request-input.ts`, `validation/document.ts`;
SDK: `packages/sdk/src/modules/data-engine.ts`.
