# Health and metrics

Two routes tell you whether a basefyio install is up and how it is doing. Neither takes a
project key.

## `GET /api/health` — liveness plus the things that fail quietly

Public, exempt from the rate limit, and used by Traefik and Docker to decide whether to route
traffic to the API container.

```bash
curl -s https://api.<your-domain>/api/health
```

```json
{
  "status": "ok",
  "checks": {
    "email": { "state": "ok", "checkedAt": "2026-10-20T11:58:00.000Z" }
  }
}
```

That is all an anonymous caller gets: the verdict a monitor needs. The operator view adds the
mail provider's own error text and which replica and build answered. Ask for it with the
operator token — the same `METRICS_TOKEN` that unlocks `/api/metrics`:

```bash
curl -s https://api.<your-domain>/api/health -H "Authorization: Bearer $METRICS_TOKEN"
```

```json
{
  "status": "degraded",
  "checks": {
    "email": {
      "state": "failing",
      "detail": "sender_domain_not_registered — example.com is not registered with the mail provider",
      "checkedAt": "2026-10-20T11:58:00.000Z"
    }
  },
  "instance": { "id": "a1b2c3d4", "role": "leader", "imageTag": "3f9c1e2a7b4d" }
}
```

Set `HEALTH_PUBLIC_DETAIL=true` to serve the operator view to every caller (the behaviour
before 2026-10-22). With neither the token nor the switch configured, nobody sees the detail.

- `instance` names the API replica that answered: its id, whether it is the `leader` that runs
  the scheduled jobs (or a `follower`), and the image tag it was started from (`IMAGE_TAG`,
  `unknown` when unset). With one replica it simply identifies the build.
- `status` is `ok` or `degraded`. **The HTTP code stays 200 in both cases** on purpose: an
  undeliverable e-mail is no reason to take the API out of the load balancer, so a monitor
  must read `status`, not the status code.
- `checks.email.state` is one of `unchecked` (not probed yet), `ok`, `failing` (`detail`, in
  the operator view, says why) or `not-configured` (no mail key at all). Password resets,
  verification codes and team invitations depend on it.

### How the mail check decides

The API asks the mail provider at startup and again every ten minutes, and it watches every
send:

- **The key.** A refusal that names the key itself (`invalid_api_key`, `missing_api_key`) is
  `failing`. A key that is only limited — for example scoped to sending, so it may not list
  domains — counts as working.
- **The sender domain.** When the provider lists the account's domains, the domain of
  `RESEND_FROM_EMAIL` must be on the list and must not be `not_started`, `pending` or
  `failed`; otherwise the check is `failing` with `sender_domain_not_registered` or
  `sender_domain_not_verified`. A listing with more pages, or in a shape the API does not
  recognise, proves nothing and is not held against the domain.
- **Every send.** A send the provider rejects turns the check `failing` with the provider's
  reason, and the next successful send turns it back to `ok`. When the rejection was about the
  sender — the key, the from address or its domain — the next probe that confirms the key and
  a sendable domain clears it too, so a fixed domain shows up within ten minutes even if nobody
  sends a mail. A rejection the probe cannot see, such as an exhausted quota, waits for a
  successful send.
- A provider that cannot be reached is not news about the key: the previous verdict stays.

What makes the process itself unhealthy (database unreachable, Keycloak down) shows up as the
route not answering; Docker's restart policy and the Traefik health check handle that.

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

`docker-compose.prod.yml` wires the same route into Traefik so a container receives traffic
only once the app answers:

```
traefik.http.services.api.loadbalancer.healthcheck.path=/api/health
traefik.http.services.api.loadbalancer.healthcheck.interval=10s
traefik.http.services.api.loadbalancer.healthcheck.timeout=5s
```

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
