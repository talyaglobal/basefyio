# Resources API

## Overview

Resources are the canonical source of provisioned infrastructure state. Operations are transient — they execute, succeed or fail, and end. Resources are durable — they persist across operations and represent the actual infrastructure that exists.

Each resource record is written (or updated) by the platform after a successful `apply()`. You can query the resource table at any time to see what infrastructure a project currently owns, without replaying operation history.

---

## List Resources

```
GET /v1/provisioning/projects/:projectId/resources
```

**Auth:** Bearer token (JWT or API key)

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| status | string | (active only) | Filter by status: `PENDING`, `ACTIVE`, `DESTROYED`, `ERROR` |
| provider | string | (all) | Filter by provider: `hetzner`, `docker` |
| limit | integer 1–100 | 50 | Page size |
| cursor | string | — | Opaque pagination cursor from a previous `nextCursor` |

By default, destroyed resources (`destroyedAt != null`) are excluded. Pass `status=DESTROYED` to retrieve them explicitly.

### Response

```json
{
  "items": [
    {
      "id": "res-uuid",
      "projectId": "proj-uuid",
      "provider": "hetzner",
      "resourceType": "server",
      "name": "web-1",
      "externalId": "12345678",
      "status": "ACTIVE",
      "desiredSpec": { "serverType": "cx11" },
      "actualSpec": { "ipv4": "1.2.3.4", "serverType": "cx11" },
      "destroyedAt": null,
      "createdAt": "2026-06-11T00:00:01.000Z",
      "updatedAt": "2026-06-11T00:01:00.000Z"
    }
  ],
  "nextCursor": null
}
```

---

## Get Resource

```
GET /v1/provisioning/resources/:id
```

**Auth:** Bearer token (JWT or API key)

Returns a single `ResourceDetail` object (same shape as one item from the list, not wrapped in `items`).

Returns `404` when the resource does not exist or the caller is not a member of the owning team.

---

## Resource Status Lifecycle

| Status | Meaning |
|--------|---------|
| `PENDING` | Resource declared but not yet created by the provider |
| `ACTIVE` | Resource created and verified by the provider API |
| `DESTROYED` | Resource deleted; returned only when `status=DESTROYED` is requested |
| `ERROR` | Last apply failed for this resource |

---

## Pagination

Results are ordered ascending by `createdAt`, then `id`. Pass the `nextCursor` value from one response as the `cursor` query parameter in the next request to retrieve the following page. A `null` `nextCursor` means there are no further pages.

Cursor encoding follows the same scheme as the events API — see [`events-api.md`](./events-api.md) for details.

---

## SDK Usage

```ts
// List first page of active resources
const page = await client.provisioning.listResources(projectId, { limit: 20 });
console.log(page.data?.items, page.data?.nextCursor);

// Get a single resource
const res = await client.provisioning.getResource(resourceId);
console.log(res.data?.actualSpec);
```

---

## CLI Usage

```bash
# List active resources for a project
basefyio resources list --project-id proj_123

# Filter by status or provider
basefyio resources list --project-id proj_123 --status ACTIVE --provider hetzner

# Paginate
basefyio resources list --project-id proj_123 --limit 10
basefyio resources list --project-id proj_123 --limit 10 --cursor <nextCursor>

# Inspect a specific resource
basefyio resources get res_abc
```

---

## Security

The `rollbackSpec` field — used internally for rollback planning — is never included in API responses.
