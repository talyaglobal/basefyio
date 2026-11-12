# Flows API (`/api/projects/:projectId/flows`)

A flow is a named trigger plus an ordered list of actions, run on the platform's background
job queue. A flow starts when you call its `trigger` route, on its cron schedule, or when an
outside system calls its own webhook URL. Each run is recorded with the result of every step.

## Authentication

Management routes: service key (`apikey`) or a dashboard session. The anon key is refused with 403.

A flow's webhook URL (`POST /api/hooks/flows/:webhookId`) takes no project key at all: the caller
proves the flow's own webhook secret instead (see [Webhook trigger](#webhook-trigger)).

## Routes

| Method | Path | Tier | Purpose |
|---|---|---|---|
| GET | `/api/projects/:projectId/flows` | service | list flows |
| POST | `/api/projects/:projectId/flows` | service | create |
| GET | `/api/projects/:projectId/flows/:id` | service | one flow |
| PATCH | `/api/projects/:projectId/flows/:id` | service | update — fields you leave out keep their saved value |
| DELETE | `/api/projects/:projectId/flows/:id` | service | delete → `{ deleted: true }` |
| POST | `/api/projects/:projectId/flows/:id/enable` | service | enable |
| POST | `/api/projects/:projectId/flows/:id/disable` | service | disable |
| POST | `/api/projects/:projectId/flows/:id/trigger` | service | run now — body `{ "input": … }` optional → `{ runId, status }` |
| GET | `/api/projects/:projectId/flows/:id/runs` | service | runs, newest first — `?limit=` (default 50, max 200), `?before=<runId>` for the next page |
| GET | `/api/projects/:projectId/flows/:id/runs/:runId` | service | one run with every step's details |
| POST | `/api/projects/:projectId/flows/:id/runs/:runId/rerun` | service | start a new run with the same input → `{ runId, status }` |
| POST | `/api/projects/:projectId/flows/:id/webhook/rotate` | service | new webhook URL + secret → `{ webhookUrl, secret }`; body `{ "secret": "…" }` sets your own → `{ webhookUrl, secretSet: true }`; `{ "keepUrl": true }` keeps the URL |
| POST | `/api/projects/:projectId/flows/:id/webhook/reveal` | service | show the current secret → `{ webhookUrl, secret }` |
| POST | `/api/hooks/flows/:webhookId` | webhook secret | fire a webhook flow → 202 `{ runId, status }` |

`trigger` answers as soon as the run is queued (`status: "queued"`). Poll
`GET …/runs/:runId` until `status` is `success` or `failed`.

## Definition

```json
{
  "name": "Notify on signup",
  "trigger": { "type": "manual" },
  "actions": [
    { "type": "log", "message": "new signup {{input.email}}" },
    { "type": "http.request", "name": "notify", "method": "POST", "url": "https://hooks.example.com/signup",
      "headers": { "Authorization": "Bearer …" }, "body": { "email": "{{input.email}}" },
      "retries": 2, "timeoutMs": 5000 },
    { "type": "db.insert", "table": "signups", "values": { "email": "{{input.email}}", "notified": "{{steps.notify.ok}}" } }
  ],
  "options": { "maxDurationMs": 60000, "maxConcurrentRuns": 1 },
  "enabled": true
}
```

| Field | Rules |
|---|---|
| `name` | required, up to 120 characters |
| `trigger.type` | `manual`, `webhook` or `schedule` |
| `trigger.cron` | schedule only, **required**: 5 fields — minute hour day-of-month month day-of-week. `*`, lists, ranges, steps, `JAN`–`DEC`, `SUN`–`SAT` and `@hourly` / `@daily` / `@weekly` / `@monthly` / `@yearly` are accepted. A seconds field and Quartz extensions (`? L W #`) are refused. |
| `trigger.timezone` | schedule only, optional IANA zone such as `Europe/Istanbul`; default UTC |
| `actions` | 1–25 actions, run in order; every action gets a stable `id` when saved |
| `options` | optional run limits, see [Limits](#limits) |

Unknown fields are not stored, and each action keeps only the fields its type uses.

### Actions

| `type` | Fields |
|---|---|
| `log` | `message` (required, up to 2000 characters) — recorded on the run |
| `http.request` | `url` (required), `method` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`; default `POST`), `headers`, `body` (not with GET/HEAD; objects are sent as JSON), `followRedirects` (default `true`) |
| `db.select` | `table`, `filters`, `select` (e.g. `"id,email"`), `limit` (1–1000, default 100) |
| `db.insert` | `table`, `values` — one row object or up to 100 rows |
| `db.update` | `table`, `filters` (**required**), `values` |

Every action also takes `name` (letters, digits, `_`; lets later steps refer to it), `retries`,
`retryDelayMs`, `timeoutMs` (not `log`) and `continueOnError`.

`filters` use the REST API's operator form: `{ "id": "eq.42", "created_at": "gt.2026-01-01" }`.
Data actions run against the project's database with service-role privileges — the same access
the service key has — and publish realtime changes like any other write.

### Templates

Any string in `message`, `url`, `headers`, `body`, `filters` and `values` may contain `{{ path }}`
placeholders. A placeholder is a dotted path, nothing more — there is no expression language.

| Placeholder | Value |
|---|---|
| `{{input.x}}` | the run's input: the `trigger` body's `input`, or the webhook payload |
| `{{steps.0.status}}`, `{{steps.notify.body.id}}` | an earlier step, by position or `name`: `ok`, `status`, `headers`, `body` (http.request); `rows`, `row`, `rowCount` (db.*); `message` (log) |
| `{{trigger.headers.x-github-event}}`, `{{trigger.query.ref}}`, `{{trigger.scheduledFor}}` | what started the run |
| `{{run.id}}`, `{{run.startedAt}}`, `{{flow.id}}`, `{{flow.name}}`, `{{now}}` | run metadata |

Array items are `items.0` or `items[0]`. A value that is exactly one placeholder keeps its type
(`"total": "{{input.total}}"` sends a number). Inside a URL, inserted values are URL-encoded;
a URL that is a single placeholder is used as given. A placeholder that resolves to nothing becomes
an empty string and is listed under the step's `warnings`. Placeholders are checked when the flow is
saved: they must start with `input`, `steps`, `trigger`, `run`, `flow` or `now`.

### Schedule trigger

The platform checks schedules once a minute. On a deployment with several API replicas only the
elected scheduler replica fires them, and each tick is recorded under a unique key, so one tick
produces exactly one run. A tick missed by a moment (for example while the scheduler moves to
another replica) is still fired on the next check; several missed ticks are not replayed as a burst.
A tick is skipped while the previous scheduled run of the same flow is still waiting to start.

A schedule flow's response carries `nextRunAt` (or `scheduleError` when the stored schedule cannot
fire, e.g. a flow saved before the cron became required).

### Webhook trigger

A webhook flow gets its own URL, `webhookUrl` in the flow, and its own secret. The secret is returned
once, in the response that creates it (`webhookSecret` on create, `secret` on rotate); afterwards only
`POST …/webhook/reveal` shows it. It is stored encrypted and never logged.

Call the URL with `POST` and a JSON or form-encoded body (up to 256 KB), proving the secret in one of
these ways — never in the URL:

| Header | Value |
|---|---|
| `X-Webhook-Secret` | the secret |
| `Authorization` | `Bearer <secret>` |
| `X-Basefyio-Signature` or `X-Hub-Signature-256` | `sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>` (GitHub sends this form) |
| `Stripe-Signature` | Stripe's signature; set the flow's secret to the endpoint's signing secret with `webhook/rotate` `{ "secret": "whsec_…" }`. Timestamps older than 5 minutes are refused. |

The payload becomes the run's `input`; the request's headers (credentials removed) and query string
are available as `{{trigger.headers.…}}` and `{{trigger.query.…}}`. The old route,
`POST …/flows/:id/trigger` with the service key, keeps working for webhook flows too.

```bash
curl -X POST "$WEBHOOK_URL" -H "X-Webhook-Secret: $SECRET" -H "Content-Type: application/json" -d '{"order":42}'
```

## Runs

A run is executed once. A failed run is **not** re-run from the start: steps that already ran (and
their side effects) never repeat on their own. A step with `retries` is retried by itself — only that
step — on network errors, timeouts and 5xx/408/429 answers, waiting `retryDelayMs` (doubling each
time). Every attempt is kept in the step's `attemptLog`. "Run again" (`…/runs/:runId/rerun`) starts a
new, separately recorded run with the same input and `retryOfId` pointing at the original.

A run row: `{ id, flowId, status, source, input, result, error, startedAt, finishedAt, createdAt,
retryOfId, meta }` — `status` is `queued`, `running`, `success` or `failed`; `source` is `manual`,
`api`, `webhook`, `schedule` or `rerun`. `result` holds one entry per step:

```json
{ "index": 1, "name": "notify", "type": "http.request", "ok": false, "status": 405,
  "detail": "HTTP 405 Method Not Allowed", "startedAt": "…", "finishedAt": "…", "durationMs": 182,
  "attempts": 1, "response": { "headers": { "content-type": "text/html" }, "body": "…",
  "truncated": false, "redirects": [] } }
```

Response bodies are stored up to 8 KB and data-action rows up to 20 per step. Set-Cookie headers are
never stored.

## Limits

| Limit | Default | Range | Where |
|---|---|---|---|
| step timeout (whole request, body included) | 10 s | 1–30 s | `timeoutMs` on the action or in `options` |
| retries per step | 0 | 0–5 | `retries` on the action or in `options` |
| first retry delay | 1 s | 0–60 s | `retryDelayMs` on the action or in `options` |
| whole run | 5 min | 10 s–15 min | `options.maxDurationMs` |
| runs of one flow at the same time | no cap | 1–20 | `options.maxConcurrentRuns` |
| runs of one project at the same time | 5 | — | `FLOW_PROJECT_MAX_CONCURRENCY` (server) |
| runs per API replica at the same time | 10 | — | `FLOW_WORKER_CONCURRENCY` (server) |

Runs of different flows and projects run side by side; a run that finds its project's or flow's slots
full waits in the queue without blocking anyone else's.

## Outbound requests

An `http.request` URL is checked before it is requested, and again for every redirect: loopback,
private and link-local addresses and the platform's own container names are refused, so a flow cannot
be used to reach internal services. Redirects (up to 5) are followed; `Authorization` and `Cookie`
are dropped when a redirect leaves the original host; 301/302 after a non-GET and 303 continue as GET.
With `followRedirects: false` the 3xx answer itself is the result. A 2xx or 3xx final answer is a
success, 4xx/5xx a failure.

Header values whose name looks like a credential (`Authorization`, `Cookie`, `*token*`, `*secret*`,
`*key*`, `*password*`, `*signature*` …) are returned as `********` by every read route. Send
`********` back unchanged in an update to keep the saved value; this only works while the action's
URL stays on the same host.

A flow that is disabled cannot be triggered (400 `Flow is disabled`).

## Example

```bash
FLOW=$(curl -s $API/projects/$PROJECT_ID/flows -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" \
  -d '{"name":"ping","trigger":{"type":"schedule","cron":"*/15 * * * *"},"actions":[{"type":"http.request","method":"GET","url":"https://example.com/health","retries":2}]}' | jq -r .id)
curl -s -X POST $API/projects/$PROJECT_ID/flows/$FLOW/trigger -H "apikey: $SERVICE_KEY" -H "Content-Type: application/json" -d '{"input":{"reason":"test"}}'
curl -s "$API/projects/$PROJECT_ID/flows/$FLOW/runs?limit=20" -H "apikey: $SERVICE_KEY"
```

## Errors

| Status | When |
|---|---|
| 400 | a definition problem, named by its field (`name is required`, `trigger.cron is required for a schedule trigger…`, `trigger.cron is not a valid cron expression: …`, `actions[1].url is required…`, `actions[0].method must be one of …`); `Flow is disabled` |
| 401 | webhook URL: the secret is missing or wrong |
| 403 | anon key; not a member of the project's team; plan without flows |
| 404 | `Flow not found`; `Run not found`; `Webhook not found` |
| 413 | webhook payload larger than 256 KB |
| 503 | the run could not be queued; webhook secrets need `DB_CRED_ENC_KEY` on the installation |

Source: `apps/platform-api/src/modules/flows/` — `flows.controller.ts`, `flow-webhook.controller.ts`,
`flows.service.ts`, `flow-scheduler.service.ts`, `flow-execute.processor.ts`, `flow-definition.ts`,
`flow-cron.ts`, `flow-template.ts`, `flow-http.ts`, `flow-webhook-auth.ts`, `flow-url-guard.ts`;
Prisma models `Flow`, `FlowRun`.
