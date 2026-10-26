# Health and metrics

Three routes tell you whether a basefyio install is up and how it is doing. None of them takes
a project key.

## `GET /api/health` — liveness plus the things that fail quietly

Public, exempt from the rate limit, and used by Traefik and Docker to decide whether the API
container is alive.

```bash
curl -s https://api.<your-domain>/api/health
```

```json
{
  "status": "ok",
  "checks": {
    "email": { "state": "ok", "checkedAt": "2026-10-20T11:58:00.000Z" },
    "database": { "state": "ok", "latencyMs": 2 },
    "redis": { "state": "ok", "latencyMs": 1 },
    "keycloak": { "state": "ok", "latencyMs": 14 },
    "storage": { "state": "ok", "latencyMs": 3 },
    "documentStore": { "state": "skipped", "detail": "no engine" }
  },
  "instance": { "id": "a1b2c3d4", "role": "leader", "imageTag": "3f9c1e2a7b4d" }
}
```

- `instance` names the API replica that answered: its id, whether it is the `leader` that runs
  the scheduled jobs (or a `follower`), and the image tag it was started from (`IMAGE_TAG`,
  `unknown` when unset). With one replica it simply identifies the build.
- `status` is `ok` or `degraded`. **The HTTP code stays 200 in both cases** on purpose: an
  undeliverable e-mail or an unreachable Keycloak is no reason to restart the API container,
  so a monitor must read `status`, not the status code.
- `checks.email.state` is one of `unchecked` (not probed yet), `ok`, `failing` (the provider
  rejected a send; `detail` says why) or `not-configured` (no mail key at all). Password
  resets, verification codes and team invitations depend on it.
- `checks.database`, `redis`, `keycloak`, `storage` and `documentStore` are probed on every
  call with a one-second limit each (`SELECT 1`, `PING`, Keycloak's `/health/ready`, MinIO's
  `/minio/health/live`, the document engine's own ping). Each is `ok`, `failing` (with a
  one-line `detail` and the `latencyMs` it took to find out) or `skipped` (not configured on
  this install). Any `failing` check makes `status` `degraded`.
- `draining: true` appears while the process is shutting down (see the next route).

## `GET /api/health/ready` — whether to send traffic here

The route for a load balancer or a proxy health check. It answers `200 {"ready":true}` when the
platform database answers within a second and the process is not shutting down, and
`503 {"ready":false,"reason":"draining"|"database"}` otherwise.

```bash
curl -s -w ' %{http_code}\n' https://api.<your-domain>/api/health/ready
```

Only the platform database decides readiness. Redis, Keycloak or storage being down degrades
the API (visible on `/api/health`), but pulling every replica out of rotation for it would turn
a partial outage into a total one.

On `SIGTERM` the API marks itself draining first, so this route turns 503 before the listener
closes; requests already in flight then finish, and the process exits by itself within 25 s —
inside the 30 s `stop_grace_period` both compose files give the `platform-api` service. A
rolling restart behind a balancer that polls this route therefore loses no request.

## `GET /api/metrics` — Prometheus text format

Metrics are published only when the operator sets `METRICS_TOKEN`; an install that never
configured one answers 401 with the message
`Metrics are not published: set METRICS_TOKEN and scrape with it as a bearer token.`
Scrape with the token:

```bash
curl -s https://api.<your-domain>/api/metrics -H "Authorization: Bearer $METRICS_TOKEN"
```

The content type is `text/plain; version=0.0.4` and the response is never cached.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `basefyio_uptime_seconds` | gauge | — | seconds since this process started |
| `basefyio_process_resident_memory_bytes` | gauge | — | resident set size |
| `basefyio_process_heap_used_bytes` | gauge | — | V8 heap in use |
| `basefyio_process_cpu_seconds_total` | counter | — | user plus system CPU time |
| `basefyio_http_requests_total` | counter | `method`, `status` | requests served. Routes are deliberately not a label: they contain tenant table and bucket names |
| `basefyio_http_request_duration_milliseconds_sum` | counter | `method`, `status` | summed request duration; divide by the request count for a mean |
| `basefyio_events_total` | counter | `event` | named events worth alerting on, such as a key refused on a route it may not reach |
| `basefyio_http_request_duration_seconds` | histogram | `route_class`, `status_class` | latency by surface — `rest`, `sql`, `auth`, `storage`, `realtime`, `dashboard`, `admin`, `other` — and status class (`2xx`, `4xx`, `5xx`); eight classes, never a path |
| `basefyio_inflight_requests` | gauge | — | requests being handled by this process right now |
| `basefyio_projects` | gauge | `status` | projects by status (`PAUSED` is the deactivated state) |
| `basefyio_bullmq_jobs` | gauge | `queue`, `state` | jobs per queue, `waiting` / `active` / `delayed` / `failed` |
| `basefyio_sse_connections` | gauge | `stream` | realtime connections this process holds: `dashboard` and `customer` |
| `basefyio_db_up`, `basefyio_redis_up` | gauge | — | 1 when the dependency answered within a second at scrape time |
| `basefyio_build_info`, `basefyio_cron_leader` | gauge | `instance_id`, `image_tag` / `instance_id` | which build each replica runs and which one owns the schedule |

The platform-level gauges (`basefyio_projects`, `basefyio_bullmq_jobs`, `basefyio_db_up`,
`basefyio_redis_up`) are read when a scrape asks and cached for ten seconds, so a busy
Prometheus cannot turn the scrape into load; a source that does not answer reports 0 rather
than failing the scrape.

Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: basefyio
    scheme: https
    metrics_path: /api/metrics
    authorization:
      credentials: <METRICS_TOKEN>
    static_configs:
      - targets: ['api.<your-domain>']
```

Suggested alerts: `basefyio_events_total` increasing on `event="anon_key_refused"`-style
events (a client is using the wrong key), a rising 5xx share of `basefyio_http_requests_total`,
and `health.status != ok` from a blackbox probe.

## Container health checks

`docker-compose.prod.yml` wires the liveness route into Traefik so a container receives traffic
only once the app answers:

```
traefik.http.services.api.loadbalancer.healthcheck.path=/api/health
traefik.http.services.api.loadbalancer.healthcheck.interval=10s
traefik.http.services.api.loadbalancer.healthcheck.timeout=5s
```

A balancer with a failure threshold (one that needs several misses before it drops a server)
should poll `/api/health/ready` instead; Traefik's single-miss check is deliberately kept on
the always-200 liveness route so a one-second database stall can never empty the rotation.

The dashboard is checked on `/login`, the website on `/`. Postgres, Keycloak, Redis, MinIO,
PgBouncer and MongoDB carry Docker `healthcheck:` blocks; `docker compose ps` shows their
state and the API's `depends_on` waits for them at start.

## Other probes

- `GET /api/v1/projects/:projectId/data-engine/health` (anon key) — `{ available, reachable }`
  for the document store behind the Data Engine.
- `GET /api/rest/v1/embeddings/status` (anon key) — whether pgvector is enabled on a project
  and how many vectors it holds.

Source: `apps/platform-api/src/modules/health/health.controller.ts`, `metrics.controller.ts`,
`metrics.service.ts`, `modules/email/email.service.ts` (deliverability states),
`docker-compose.prod.yml`.
