# Content Layer API Reference

## Overview

The content layer provides CRUD operations for project entities (tables) via two interfaces:
- **Native API** at `/v1/projects/:projectId/items/:entityName`
- **Supabase-compat layer** at `/rest/v1/:table` (drop-in compatibility)

---

## Authentication

All endpoints require one of:
- `Authorization: Bearer <jwt-token>` — JWT issued by the platform auth service
- `Authorization: Bearer <api-key>` — project-scoped API key
- `apikey: <api-key>` header (Supabase-compat only)

Pass `x-project-id: <projectId>` when using the Supabase-compat layer.

---

## Items API — `/v1/projects/:projectId/items`

### List items

```
GET /v1/projects/:projectId/items/:entityName
```

Query parameters:

| Param | Description | Example |
|-------|-------------|---------|
| `limit` | Max rows (default 20, max 100) | `?limit=50` |
| `cursor` | Opaque cursor for next page | `?cursor=<base64url>` |
| `sort` | Column to sort by | `?sort=created_at` |
| `order` | `asc` or `desc` | `?order=desc` |
| `filter[col]` | Equality filter on a column | `?filter[status]=active` |

Response:
```json
{
  "data": [...],
  "nextCursor": "dXNlcl8x",
  "total": 42
}
```

### Get single item

```
GET /v1/projects/:projectId/items/:entityName/:id
```

Response: the row object directly.

### Create item

```
POST /v1/projects/:projectId/items/:entityName
Content-Type: application/json

{ "name": "Alice", "status": "active" }
```

Response (201): the created row.

### Update item

```
PATCH /v1/projects/:projectId/items/:entityName/:id
Content-Type: application/json

{ "status": "inactive" }
```

Response: the updated row.

### Delete item

```
DELETE /v1/projects/:projectId/items/:entityName/:id
```

Response (200): `{ "deleted": true, "id": "..." }`

---

## File API — `/v1/projects/:projectId/items/:entityName/:id/files`

### Upload a file

```
POST /v1/projects/:projectId/items/:entityName/:id/files
Content-Type: multipart/form-data

file=<binary>
```

Response (201): `{ "key": "...", "url": "..." }`

### List files

```
GET /v1/projects/:projectId/items/:entityName/:id/files
```

Response: array of `{ key, url, size, contentType, createdAt }`

### Delete file

```
DELETE /v1/projects/:projectId/items/:entityName/:id/files/:key
```

Response (200): `{ "deleted": true }`

---

## Supabase-Compat Layer — `/rest/v1`

Drop-in replacement for `@supabase/supabase-js` REST calls.

### Select rows

```
GET /rest/v1/:table?select=*&status=eq.active&order=created_at.desc&limit=20
x-project-id: <projectId>
```

Response: array of row objects (matches Supabase format).

### Insert row(s)

```
POST /rest/v1/:table
x-project-id: <projectId>
Content-Type: application/json

{ "name": "Bob" }
```

Also accepts an array: `[{ "name": "Alice" }, { "name": "Bob" }]`

Response (201): array of created rows.

### Update rows

```
PATCH /rest/v1/:table?id=eq.<id>
x-project-id: <projectId>
Content-Type: application/json

{ "status": "inactive" }
```

Response: array with the updated row.

### Delete rows

```
DELETE /rest/v1/:table?id=eq.<id>
x-project-id: <projectId>
```

Response (200): array with the deleted row info.

### Supported filter operators (V1)

| Operator | Supported | Notes |
|----------|-----------|-------|
| `eq` | Yes | `?col=eq.value` |
| `neq`, `gt`, `gte`, `lt`, `lte` | Parsed, not enforced | V2 roadmap |
| `like`, `ilike` | Parsed, not enforced | V2 roadmap |
| `is` | Parsed, not enforced | V2 roadmap |
