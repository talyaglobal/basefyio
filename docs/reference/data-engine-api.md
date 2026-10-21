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
the document), `sort` (`{ "path": "createdAt", "direction": "desc" }`), `limit`, `offset`, and
returns a page `{ data, total, hasMore, nextCursor? }`. Document size, nesting depth and array length
are bounded by `DATA_ENGINE_MAX_DOC_KB` (1024), `DATA_ENGINE_MAX_NESTING_DEPTH` (8) and
`DATA_ENGINE_MAX_ARRAY_ITEMS` (1000).

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
`data-engine.service.ts`, `apps/platform-api/src/modules/data-query/data-query.controller.ts`,
`dto/*.ts`, `apps/platform-api/src/modules/data-structures/data-structures.controller.ts`;
SDK: `packages/sdk/src/modules/data-engine.ts`.
