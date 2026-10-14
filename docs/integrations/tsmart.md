# tsmart.ai project feed

tsmart.ai bills companies per basefyio project. Once an hour it reads one
read-only endpoint that lists every basefyio project with its team, an owner
address and the current usage figures.

The endpoint is platform-to-platform. It is not part of the customer API, it
does not take a dashboard session, and it is off unless the operator configures
a token hash.

## Endpoint

```
GET https://api.<domain>/api/integrations/tsmart/projects
Authorization: Bearer <token>
```

There are no query parameters. The response is sent with `Cache-Control: no-store`.

### Response

```json
{
  "object": "list",
  "generated_at": "2026-10-14T12:00:00.000Z",
  "data": [
    {
      "id": "3f2b8c1e-0000-4000-8000-000000000001",
      "name": "Example shop",
      "status": "ACTIVE",
      "database_type": "RELATIONAL",
      "created_at": "2026-03-01T09:15:00.000Z",
      "deleted_at": null,
      "deactivated_at": null,
      "team": { "id": "7a1d0c2e-0000-4000-8000-000000000002", "name": "Example Ltd", "slug": "example-ltd" },
      "owner_email": "owner@example.com",
      "usage": {
        "db_size_bytes": 52428800,
        "storage_bytes": 1073741824,
        "api_requests_month": 18342,
        "bandwidth_month": 734003200,
        "db_size_measured_at": "2026-10-14T06:00:02.000Z",
        "storage_measured_at": "2026-10-14T06:00:05.000Z"
      }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id`, `name` | The project. `id` is stable; use it as the billing key. |
| `status` | `ACTIVE`, `PAUSED`, `DEACTIVATED` or `DELETED`. |
| `database_type` | `RELATIONAL` or `NOSQL`. |
| `created_at` | When the project was created (ISO 8601, UTC). |
| `deleted_at` | When it was moved to trash; `null` otherwise. Trashed projects are purged after 24 hours. |
| `deactivated_at` | When it was deactivated; `null` otherwise. Deactivated projects are purged after 14 days. |
| `team` | The basefyio team (company) that owns the project. |
| `owner_email` | The address of the user who created the project; if that user is gone or unknown, the team's earliest `OWNER` member; `null` if neither exists. |
| `usage.db_size_bytes` | Size of the project's database (`pg_database_size`). |
| `usage.storage_bytes` | Bytes stored in the project's buckets. |
| `usage.api_requests_month` | API requests counted this calendar month. |
| `usage.bandwidth_month` | Request plus response bytes this calendar month. |
| `usage.db_size_measured_at`, `usage.storage_measured_at` | When those two figures were last measured; `null` = never measured yet. |

Rules worth knowing when billing from this feed:

- **Every project row still in the database is listed**, including `DELETED`
  and `DEACTIVATED` ones that have not been purged yet. A project that
  disappears from the feed has been purged.
- **Order and cap.** Rows are ordered by `created_at` (oldest first, then `id`)
  and capped at 5000. basefyio logs a warning when the cap is reached; newer
  projects beyond it are left out.
- **No usage row yet** (a project that was never measured) gives `0` for every
  counter and `null` for both timestamps.
- **Freshness.** Database and storage sizes are measured every 6 hours. The
  request and bandwidth counters are collected live and written to the figures
  this feed reads at least every 6 hours, so they can lag by up to that much.
- **Monthly reset.** `api_requests_month` and `bandwidth_month` reset to 0 at
  00:00 on the 1st of each month (server time). The last value read before the
  reset may miss up to 6 hours of the closing month.
- **Frozen projects.** Sizes are only re-measured for `ACTIVE` and `PAUSED`
  projects; a `DEACTIVATED` or `DELETED` project keeps the last values measured
  before its status changed.
- All byte counts are plain JSON numbers (exact up to 8 PiB).

### Errors

| Status | When |
|---|---|
| `401` | No `Authorization: Bearer` header, a token longer than 256 characters, or a wrong token. The body is the same generic `Unauthorized` in every case. |
| `404` | The feature is off: `TSMART_INTEGRATION_TOKEN_SHA256` is unset or not exactly 64 hex characters. Every request gets the same 404 a missing route gets, whatever token it carries. |
| `429` | The platform-wide rate limit (300 requests per minute per client IP) applies to this route like any other. |

## The token

- **tsmart keeps the token. basefyio keeps only its sha256**, as 64 hex
  characters, in the platform API's environment variable
  `TSMART_INTEGRATION_TOKEN_SHA256`. A leaked basefyio environment or database
  dump therefore does not hand out read access to the feed.
- The platform API hashes the presented token and compares the digests in
  constant time. The token is never logged.
- No dashboard user, API key or project key opens this endpoint, and no project
  key or user session is needed or accepted in place of the token.
- Calls to this endpoint are never counted as usage of any project, even if a
  request carries `x-project-id` or `apikey`.

### Setting it up

1. Generate a token (any printable string up to 256 characters; 32 random bytes
   is plenty):

   ```sh
   TOKEN=$(openssl rand -hex 32)
   ```

2. Store `$TOKEN` in tsmart's secret store.
3. Compute the hash of the exact token bytes (`printf %s`, not `echo`, so no
   newline is hashed):

   ```sh
   printf %s "$TOKEN" | sha256sum | cut -d' ' -f1
   ```

4. Put that hash into `TSMART_INTEGRATION_TOKEN_SHA256` in the environment file
   the production stack reads (`docker-compose.prod.yml` passes it to
   `platform-api`), and recreate the `platform-api` container. At boot the API
   logs `tsmart integration endpoint is enabled`, or a warning with the value's
   length if it is set but malformed.
5. Discard the local copy of `$TOKEN`.

### Rotating

Rotate by replacing both: generate a new token, store it in tsmart, put its
hash into `TSMART_INTEGRATION_TOKEN_SHA256` and recreate `platform-api`. Only
one hash is accepted at a time, so calls made between the two changes get
`401`; with an hourly poll, doing both within the same hour avoids a missed
run (or tsmart simply retries).

To switch the feed off, empty the variable and recreate `platform-api`; the
route then answers `404`.

## Code

- `apps/platform-api/src/modules/integrations/tsmart/` — module, controller,
  guard (`tsmart-integration.guard.ts`), service and tests
  (`tsmart-integration.spec.ts`).
- `apps/platform-api/src/common/middleware/usage-tracking.middleware.ts` — skips
  this route so it never counts against a project.
