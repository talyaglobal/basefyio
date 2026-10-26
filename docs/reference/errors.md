# Error reference

Every error the API returns is JSON with the same three fields, produced by one global filter
(`apps/platform-api/src/common/filters/all-exceptions.filter.ts`):

```json
{
  "statusCode": 401,
  "message": "Missing apikey",
  "timestamp": "2026-10-20T12:00:00.000Z"
}
```

`message` is a string, or an **array of strings** when the request body failed validation.
Some handlers attach a stable, machine-readable `code` next to the message
(for example `"code": "invalid_code"` on a wrong second-factor code, or an MFA challenge
that expired); when present, branch on `code` rather than on the English text.
Unexpected failures (anything that is not a deliberate HTTP exception) are logged on the
server and reported as `500` with the message `Internal server error` and nothing else — the
API never leaks a stack trace or a database error it did not choose to surface.

## Status codes

| Status | Meaning | Typical messages |
|---|---|---|
| 400 | the request is malformed or refused by a rule | validation (below); `Invalid table name`; `Invalid function name`; `Invalid ${what}: "…"` from the PostgREST parser; `Empty body`; `No columns provided`; `Expiry must be between 60 and 604800 seconds`; `Bucket name must be 3-63 chars, alphanumeric and hyphens, cannot start/end with hyphen`; a refused SQL pattern; `Password must be at least N characters`; `Invalid or expired verification code` |
| 401 | no usable credential | `Missing apikey`; `Invalid API key`; `The service key must be sent in the apikey header, not the query string`; `Invalid or expired access token`; `Invalid email or password`; `Invalid or expired refresh token`; `Invalid or expired API token`; `Unauthorized` (dashboard session missing or expired) |
| 403 | the credential is valid but not allowed here | `This route requires the service key and must be called from your server, never from a browser. The anon key is public and cannot be used here.`; `This route requires a signed-in user. Send the end user's access token as a Bearer token alongside the anon key, or call it with the service key from your server.`; `This API key does not belong to the requested project`; `API token is missing required scope(s): …`; `Function "<fn>" is SECURITY DEFINER …`; `Not a member of this team`; `Self-signup is disabled for this project`; `Invite requires service_role key`; `Missing Authorization header` (a route that needs the end user's token) |
| 404 | the named thing does not exist for this caller | `Project not found`; `Bucket "<name>" not found`; `Object "<key>" not found`; `Document "<id>" not found`; `Flow not found`; `User not found` |
| 409 | conflict with existing state | `Email already registered`; `Email already in use`; `Bucket "<name>" already exists`; `User already exists in this project` |
| 413 | body too large | JSON bodies above 10 MB; uploads above the storage limit are reported as 400 by the file validator |
| 429 | rate limit | 300 requests per minute per IP on non-data routes (`ThrottlerException: Too Many Requests`) |
| 500 | unexpected | `Internal server error` |
| 503 | a dependency is down or a module is off | `Data Engine is temporarily unavailable …`; `Codefyio adapter is not configured` |

## Validation errors

Request bodies are validated with a whitelist (`ValidationPipe({ whitelist, forbidNonWhitelisted })`
in `main.ts`). Two consequences:

- A property the route does not declare is an error, not ignored:
  `"message": ["property foo should not exist"]`.
- Type and range rules produce one message per failing rule:
  `"message": ["projectId must be a UUID", "limit must not be greater than 1000"]`.

Routes whose body is typed inline (for example `{ email, password }` on sign-in) are not
validated this way; they fail inside the handler with a 400 or 401 of their own.

## Key and tier errors

These come from the key guard (`common/guards/api-key.guard.ts`) and are the ones to look at
first when a call "should work":

| You sent | On a route that is | Result |
|---|---|---|
| anon key | `service` | 403 "This route requires the service key …" |
| anon key, no Bearer | `anon + user` | 403 "This route requires a signed-in user …" |
| anon key + Bearer that is not a valid token of this project's realm | anything | 401 "Invalid or expired access token" (the guard never silently downgrades a bad token to anon) |
| anon key + Bearer equal to the key itself | anything | treated as anon (many clients mirror the key into `Authorization`) |
| service key in `?apikey=` | anything | 401 "The service key must be sent in the apikey header, not the query string" |
| a key of project A | a route naming project B in the path, body or query | 403 "This API key does not belong to the requested project" |

Two environment switches relax the last two rules to *log-only* for an operator who knows
they depend on the old behaviour: `ANON_WRITE_BINDING=log` and
`SERVICE_KEY_PROJECT_BINDING=log` (see [configuration.md](./configuration.md)). The default
refuses.

## Row-level security "errors"

A statement blocked by a policy is not an error: a `SELECT` returns fewer rows (often none),
and an `INSERT`/`UPDATE`/`DELETE` reports `count: 0` or fails with Postgres
`new row violates row-level security policy` (surfaced as 400 with that message). A table
that is readable to the anon key is a table without `ENABLE ROW LEVEL SECURITY` — see
[../concepts/security-model.md](../concepts/security-model.md).

## Realtime stream

The SSE route (`GET /api/realtime/v1/stream`) answers 401 before the stream opens for a
missing or invalid key and for the service key in the URL; once open, errors are delivered as
connection closes, and the SDK reconnects with exponential backoff.

Source: `apps/platform-api/src/common/filters/all-exceptions.filter.ts`, `main.ts`,
`common/guards/api-key.guard.ts`, `modules/api-tokens/scopes.guard.ts`, `app.module.ts`
(throttler), and the message strings in each module's service.

## Admission errors

| HTTP | `code` | Meaning | What to do |
|---|---|---|---|
| 429 | `rate_limited` | The project used its plan's request rate (token bucket). `RateLimit-*` headers say how much is left and when it refills. | Retry after `Retry-After` seconds with jitter; raise the plan or spread the load. |
| 503 | `overloaded` | The API process is at its concurrency limit and the wait line is full, or the instance is restarting. | Retry after `Retry-After` (1 s) with jitter; idempotent requests only. |

A deactivated project is not an error: its first keyed request wakes it and is served.
