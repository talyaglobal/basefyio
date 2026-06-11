# Operation Events API Reference

## Endpoint

```
GET /v1/provisioning/operations/:id/events
```

Returns a paginated, ascending-ordered list of lifecycle events for a provisioning operation.

---

## Authentication

Pass a Bearer token in the `Authorization` header. Both JWT session tokens and long-lived API keys are accepted.

```
Authorization: Bearer <token>
```

---

## Query Parameters

| Parameter | Type    | Default | Description                                              |
|-----------|---------|---------|----------------------------------------------------------|
| `limit`   | integer | `50`    | Number of events per page. Range: 1–100.                 |
| `cursor`  | string  | —       | Opaque pagination cursor from a previous `nextCursor`.   |

---

## Response Shape

```json
{
  "events": [
    {
      "id": "evt_01j9...",
      "kind": "STATUS_CHANGED",
      "fromStatus": "PENDING",
      "toStatus": "RUNNING",
      "actorUserId": "usr_01j8...",
      "metadata": {},
      "createdAt": "2026-06-10T14:00:00.000Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA2LTEwVDE0OjAwOjAwLjAwMFoiLCJpZCI6ImV2dF8wMWo5Li4uIn0"
}
```

`nextCursor` is `null` when there are no further pages.

---

## Ordering

Events are returned **ascending by `createdAt`**, then by `id` as a tiebreaker. This guarantees a stable, reproducible order when multiple events share the same millisecond timestamp.

---

## Cursor Encoding

The cursor is a **base64url-encoded JSON object**:

```json
{ "createdAt": "2026-06-10T14:00:00.000Z", "id": "evt_01j9..." }
```

Treat it as opaque — the encoding may change between API versions. Always pass the raw string received in `nextCursor` without modification.

---

## Pagination Example

**First page**

```bash
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.basefyio.io/v1/provisioning/operations/op_01j8.../events?limit=20"
```

**Subsequent page** (using `nextCursor` from the previous response)

```bash
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.basefyio.io/v1/provisioning/operations/op_01j8.../events?limit=20&cursor=eyJjcmVhdGVkQXQi..."
```

---

## Event Kinds

| Kind                   | Description                                                     |
|------------------------|-----------------------------------------------------------------|
| `OPERATION_STARTED`    | The operation transitioned from PENDING to RUNNING.             |
| `STATUS_CHANGED`       | A generic status transition not covered by the above kinds.     |
| `OPERATION_COMPLETED`  | The operation finished successfully.                            |
| `OPERATION_FAILED`     | The operation ended in a terminal failure.                      |
| `OPERATION_CANCELLED`  | The operation was cancelled before completion.                  |

---

## SDK Usage

```ts
const page = await client.provisioning.getOperationEvents(operationId, { limit: 20 });
console.log(page.data?.events, page.data?.nextCursor);

// Iterate all pages
let cursor: string | undefined;
do {
  const result = await client.provisioning.getOperationEvents(operationId, { limit: 50, cursor });
  for (const event of result.data?.events ?? []) {
    console.log(event.kind, event.createdAt);
  }
  cursor = result.data?.nextCursor ?? undefined;
} while (cursor);
```

---

## CLI Usage

```bash
# First page, 20 events
basefyio operations logs <operationId> --limit 20

# Next page using cursor from previous output
basefyio operations logs <operationId> --limit 20 --cursor <nextCursor>

# Stream all events until operation completes (--follow flag)
basefyio operations logs <operationId> --follow
```
