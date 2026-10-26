# Platform status API (`/api/platform-status`)

What the public status page and the console's Reliability page read, and how an external monitor
feeds its probe results in. The indicators, targets and counting rules are in
[concepts/sla.md](../concepts/sla.md).

## Routes

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/platform-status/public` | public | per-indicator state, last 90 days, month and 90-day availability, open and recent incidents, maintenance; cached 30 s |
| GET | `/api/platform-status/availability` | session | `{ monthAvailabilityPct, statusUrl }` — the line on an organization's billing page |
| POST | `/api/platform-status/samples` | probe token | an external vantage point's results (see below) |
| POST | `/api/platform-status/deploys` | probe token | `{ imageTag, note? }` — a deploy marker on the timeline (the API also records one for itself at boot) |
| GET | `/api/platform-status/console` | root | the public payload plus burn rates, error budget, p95 latency, error rate, deploys, the latest samples, host events and the setup state |
| POST | `/api/platform-status/incidents` | root | `{ title, status?, impact?, components?, startedAt?, excludedFromSlo?, text? }` |
| PATCH | `/api/platform-status/incidents/:id` | root | the same fields; a status change or a `text` appends an update; `RESOLVED` stamps `resolvedAt` |
| POST | `/api/platform-status/canary` | root | create the canary project once (table `slo_probe`, public object `probe/ok.txt`) in the caller's personal organization |

The **probe token** is `PLATFORM_STATUS_PROBE_TOKEN`, sent as `Authorization: Bearer <token>`.
Unset means those two routes answer 401.

## Feeding samples from outside

The internal prober runs inside the platform and cannot see a dead host, so at least one monitor
should run elsewhere and post the same probes. Two body shapes are accepted:

```json
{ "vantage": "fsn1-kuma", "samples": [
  { "probe": "api", "ok": true, "latencyMs": 142, "statusCode": 200, "ts": "2026-10-26T13:00:05Z" },
  { "probe": "auth", "ok": false, "statusCode": 502, "detail": "HTTP 502" }
] }
```

`probe` is one of `api`, `dashboard`, `auth`, `database`, `storage`, `realtime`; `ts` defaults to now.

An **Uptime Kuma** webhook notification works unchanged when each monitor is named after its
probe (`api`, `dashboard`, …): the body's `monitor.name` picks the probe, `heartbeat.status`
(1 = up) the verdict, `heartbeat.ping` the latency, and the vantage is recorded as `external`.
Set the webhook URL to `https://api.<domain>/api/platform-status/samples` with a custom header
`Authorization: Bearer <token>`.

## Setup order

1. Set `PLATFORM_STATUS_ENABLED=true` (and a `PLATFORM_STATUS_PROBE_TOKEN`) in the environment
   and deploy; the prober starts on the scheduler leader and the first samples appear within a
   minute. Without a canary only the API readiness, dashboard and auth probes run.
2. In the console, Reliability → create the canary (or `POST /api/platform-status/canary` as
   ROOT). It is a real project named `slo-canary` in your personal organization and uses one
   project slot; the idle sweep never deactivates it. The keyed REST, database endpoint,
   storage and realtime probes start on the next tick.
3. Point an external monitor at the same endpoints and its webhook at the samples route.
4. Announce maintenance from the console before it starts; its minutes are excluded.

## How a minute is judged

Samples from every vantage point are grouped into minutes; a minute is down when more than half
of the vantage points that reported in it failed. The 5-minute roll-up writes one row per day
and indicator (`platform_slo_windows`); samples are kept 90 days, windows for good. An
indicator that fails for three consecutive minutes opens an incident on the status page, raises
a critical alert in the console's red bar and e-mails every ROOT user; five clean minutes resolve
it. Deploys are markers on the timeline and still count as downtime.
