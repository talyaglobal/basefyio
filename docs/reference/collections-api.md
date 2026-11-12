# Collections API

Document collections are schema-free JSON documents stored in the project's own PostgreSQL
database (one table per collection with a JSONB `data` column), queried with a
MongoDB-flavoured filter language. Two route families serve them: a public, key-authenticated
one for applications and an administrative one for creating and dropping collections.

Collections are not Data Engine entities (`data-engine-api.md`): entities live in the Data
Engine store, need the service key, and add declared fields, versions and recoverable deletes.
The two are separate; nothing is shared or synced between them.

## Public routes (`/api/rest/v1/collections`)

`apikey` header; anon key alone is the `anon` role, anon key + `Authorization: Bearer <user
token>` is `authenticated`, service key bypasses row-level security. Exempt from the per-IP
rate limit.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/rest/v1/collections/:collection` | anon | query documents |
| POST | `/api/rest/v1/collections/:collection` | anon | insert one document or an array |
| GET | `/api/rest/v1/collections/:collection/:docId` | anon | one document |
| PATCH | `/api/rest/v1/collections/:collection/:docId` | anon | merge fields into a document |
| PUT | `/api/rest/v1/collections/:collection/:docId` | anon | replace a document |
| DELETE | `/api/rest/v1/collections/:collection/:docId` | anon | delete a document |

### Querying

```
GET /api/rest/v1/collections/posts?filter={"status":"published","views":{"$gte":100}}&sort={"views":-1}&limit=20&offset=0&project={"title":1,"views":1}
```

Query parameters are JSON-encoded: `filter` (object), `sort` (`{ field: 1 | -1 }`),
`project` (`{ field: 0 | 1 }`), `limit` (default 50, max 1000), `offset` (default 0).
Response:

```json
{ "data": [ { "id": "…", "data": { "title": "…", "views": 120 }, "created_at": "…", "updated_at": "…" } ], "count": 1 }
```

Filter operators (`apps/platform-api/src/modules/projects/nosql-filter.util.ts`):

| Filter | Meaning |
|---|---|
| `{ field: value }` | equality (JSON containment); also matches an element of an array field; works on dotted paths (`{ "meta.city": "Ankara" }`) |
| `{ field: { sub: value } }` | the field contains this sub-document |
| `{ field: { $eq, $ne } }` | equal / not equal (text comparison); `$eq` also matches an array element |
| `{ field: { $gt, $gte, $lt, $lte } }` | numeric comparison (a non-numeric operand is a 400; non-numeric stored values never match) |
| `{ field: { $in: [...] }, $nin }` | membership (also any array element); `$nin` matches documents without the field |
| `{ field: { $contains: v } }` | array containment |
| `{ field: { $all: [...] } }` | the array holds every value |
| `{ field: { $elemMatch: {...} } }` | some array element matches: `{ "items": { "$elemMatch": { "sku": "A", "qty": { "$gt": 2 } } } }`, or for scalars `{ "scores": { "$elemMatch": { "$gte": 80 } } }` |
| `{ field: { $exists: true|false } }` | field present (nested paths supported) |
| `{ field: { $regex, $iregex } }` | regular expression, case-sensitive / insensitive |
| `{ field: { $like, $ilike } }` | SQL LIKE pattern (`%`, `_`), case-sensitive / insensitive |
| `{ $and: [...] }`, `{ $or: [...] }` | boolean combinations (non-empty arrays of filter objects) |
| `"a.b.c"` | nested path |

`sort` takes `1`/`-1` or `"asc"`/`"desc"` per field (anything else is a 400); `id` is always the
last tiebreaker, and without a sort documents come in creation order, so paging is stable.

### Writing

`POST` body is one object or an array of objects (each at most 16 MB). The response is
`{ "count": n }`, or the inserted documents when the request carries
`Prefer: return=representation`. `PATCH` merges the body into `data`; `PUT` replaces `data`;
both and `DELETE` answer the document (or 404 `Document "<id>" not found`). Writes are
published to realtime subscribers of `collection:<name>` when the collection is enabled.

## Administrative routes (`/api/projects/:projectId/collections`)

Service key, or a dashboard session. The anon key is refused.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/collections` | service | list collections |
| POST | `/api/projects/:projectId/collections` | service | create — body `{ "name": "posts" }` |
| DELETE | `/api/projects/:projectId/collections/:collectionName` | service | drop a collection and its documents |
| GET | `/api/projects/:projectId/collections/:collectionName/documents` | service | query (same `filter`/`sort`/`project`/`limit`/`offset` parameters) |
| POST | `/api/projects/:projectId/collections/:collectionName/documents` | service | insert |
| GET | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | read one |
| PATCH | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | merge |
| PUT | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | replace |
| DELETE | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | delete one |
| DELETE | `/api/projects/:projectId/collections/:collectionName/documents` | service | body `{ "filter": {…} }` — delete the matching documents |
| GET | `/api/projects/:projectId/collections/:collectionName/count` | service | `?filter={…}` — count the matching documents |
| POST | `/api/projects/:projectId/collections/:collectionName/indexes` | service | body `{ "fieldPath": "status" }` or a nested path `"address.city"` — index a document field |
| GET | `/api/projects/:projectId/collections/:collectionName/indexes` | service | `[{ name, fieldPath, definition, system }]`; `system` marks the primary key and GIN index every collection has |
| DELETE | `/api/projects/:projectId/collections/:collectionName/indexes/:indexName` | service | drop an index you added (system indexes: 400) |

Collection names must match `^[A-Za-z_][A-Za-z0-9_]*# Collections API

Document collections are schema-free JSON documents stored in the project's own PostgreSQL
database (one table per collection with a JSONB `data` column), queried with a
MongoDB-flavoured filter language. Two route families serve them: a public, key-authenticated
one for applications and an administrative one for creating and dropping collections.

Collections are not Data Engine entities (`data-engine-api.md`): entities live in the Data
Engine store, need the service key, and add declared fields, versions and recoverable deletes.
The two are separate; nothing is shared or synced between them.

## Public routes (`/api/rest/v1/collections`)

`apikey` header; anon key alone is the `anon` role, anon key + `Authorization: Bearer <user
token>` is `authenticated`, service key bypasses row-level security. Exempt from the per-IP
rate limit.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/rest/v1/collections/:collection` | anon | query documents |
| POST | `/api/rest/v1/collections/:collection` | anon | insert one document or an array |
| GET | `/api/rest/v1/collections/:collection/:docId` | anon | one document |
| PATCH | `/api/rest/v1/collections/:collection/:docId` | anon | merge fields into a document |
| PUT | `/api/rest/v1/collections/:collection/:docId` | anon | replace a document |
| DELETE | `/api/rest/v1/collections/:collection/:docId` | anon | delete a document |

### Querying

```
GET /api/rest/v1/collections/posts?filter={"status":"published","views":{"$gte":100}}&sort={"views":-1}&limit=20&offset=0&project={"title":1,"views":1}
```

Query parameters are JSON-encoded: `filter` (object), `sort` (`{ field: 1 | -1 }`),
`project` (`{ field: 0 | 1 }`), `limit` (default 50, max 1000), `offset` (default 0).
Response:

```json
{ "data": [ { "id": "…", "data": { "title": "…", "views": 120 }, "created_at": "…", "updated_at": "…" } ], "count": 1 }
```

Filter operators (`apps/platform-api/src/modules/projects/nosql-filter.util.ts`):

| Filter | Meaning |
|---|---|
| `{ field: value }` | equality (JSON containment); also matches an element of an array field; works on dotted paths (`{ "meta.city": "Ankara" }`) |
| `{ field: { sub: value } }` | the field contains this sub-document |
| `{ field: { $eq, $ne } }` | equal / not equal (text comparison); `$eq` also matches an array element |
| `{ field: { $gt, $gte, $lt, $lte } }` | numeric comparison (a non-numeric operand is a 400; non-numeric stored values never match) |
| `{ field: { $in: [...] }, $nin }` | membership (also any array element); `$nin` matches documents without the field |
| `{ field: { $contains: v } }` | array containment |
| `{ field: { $all: [...] } }` | the array holds every value |
| `{ field: { $elemMatch: {...} } }` | some array element matches: `{ "items": { "$elemMatch": { "sku": "A", "qty": { "$gt": 2 } } } }`, or for scalars `{ "scores": { "$elemMatch": { "$gte": 80 } } }` |
| `{ field: { $exists: true|false } }` | field present (nested paths supported) |
| `{ field: { $regex, $iregex } }` | regular expression, case-sensitive / insensitive |
| `{ field: { $like, $ilike } }` | SQL LIKE pattern (`%`, `_`), case-sensitive / insensitive |
| `{ $and: [...] }`, `{ $or: [...] }` | boolean combinations (non-empty arrays of filter objects) |
| `"a.b.c"` | nested path |

`sort` takes `1`/`-1` or `"asc"`/`"desc"` per field (anything else is a 400); `id` is always the
last tiebreaker, and without a sort documents come in creation order, so paging is stable.

### Writing

`POST` body is one object or an array of objects (each at most 16 MB). The response is
`{ "count": n }`, or the inserted documents when the request carries
`Prefer: return=representation`. `PATCH` merges the body into `data`; `PUT` replaces `data`;
both and `DELETE` answer the document (or 404 `Document "<id>" not found`). Writes are
published to realtime subscribers of `collection:<name>` when the collection is enabled.

## Administrative routes (`/api/projects/:projectId/collections`)

Service key, or a dashboard session. The anon key is refused.

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/collections` | service | list collections |
| POST | `/api/projects/:projectId/collections` | service | create — body `{ "name": "posts" }` |
| DELETE | `/api/projects/:projectId/collections/:collectionName` | service | drop a collection and its documents |
| GET | `/api/projects/:projectId/collections/:collectionName/documents` | service | query (same `filter`/`sort`/`project`/`limit`/`offset` parameters) |
| POST | `/api/projects/:projectId/collections/:collectionName/documents` | service | insert |
| GET | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | read one |
| PATCH | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | merge |
| PUT | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | replace |
| DELETE | `/api/projects/:projectId/collections/:collectionName/documents/:docId` | service | delete one |
| DELETE | `/api/projects/:projectId/collections/:collectionName/documents` | service | body `{ "filter": {…} }` — delete the matching documents |
| GET | `/api/projects/:projectId/collections/:collectionName/count` | service | `?filter={…}` — count the matching documents |
 (400 `Invalid collection name`); a new
collection's name may be at most 63 characters (PostgreSQL would silently shorten a longer one).
Dropping a collection that does not exist is a 404.

## SDK

```ts
const posts = bf.collection<Post>('posts');
await posts.insert({ title: 'Hello', status: 'draft' });
const { data } = await posts.find({ status: 'published' }).sort('views', 'desc').limit(10);
await posts.updateById(id, { views: 42 });
await bf.collections.create('posts');      // administrative: needs the service key
```

## Errors

| Status | When |
|---|---|
| 400 | `Invalid collection name: "…"`; `No documents provided`; `Document exceeds maximum size of 16MB`; a malformed `filter`/`sort`/`project` JSON; `Invalid document id` (ids are UUIDs); an unknown operator; an index request without `fieldPath` |
| 401 / 403 | key problems as everywhere; anon key on an administrative route |
| 404 | `Document "<id>" not found`; unknown collection (also when dropping one); unknown index |

Source: `apps/platform-api/src/modules/projects/public-collection-api.controller.ts`,
`public-collection-api.service.ts`, `collection.controller.ts`, `collection.service.ts`,
`nosql-filter.util.ts`; SDK: `packages/sdk/src/modules/collection.ts`.
