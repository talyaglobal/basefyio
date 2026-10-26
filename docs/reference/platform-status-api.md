# Platform status API (`/api/platform-status`)

What the public status page and the console's Reliability page read, and how an external monitor
feeds its probe results in. The indicators, targets and counting rules are in
[concepts/sla.md](../concepts/sla.md).

## Routes

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/platform-status/public` | public | per-indicator state and what each probe covers, last 90 days, month and 90-day availability, open and recent incidents, maintenance, the incident-tracked components (provisioning, backups, billing, website, e-mail) and the months with history; cached 30 s |
| GET | `/api/platform-status/history?month=YYYY-MM` | public | one calendar month: a figure per day and per indicator, the month's availability against its target, incident count, worst daily p95, every incident that started in the month, and the neighbouring months; the current month when `month` is omitted; cached 60 s while the month runs, an hour once it has ended |
| POST | `/api/platform-status/subscriptions` | public | `{ email }` — asks for incident mail; answers `{ state: "pending" }` after sending a confirmation link, or `{ state: "already" }` for a confirmed address; 3 requests per address and 200 overall per hour |
| GET | `/api/platform-status/subscriptions/confirm?token=` | link in the mail | confirms, then redirects to `https://status.<domain>/?subscribed=1` (or `0` for a stale token) |
| GET | `/api/platform-status/subscriptions/unsubscribe?token=` | link in every incident mail | ends the subscription, then redirects to `…/?unsubscribed=1` |
| GET | `/api/platform-status/availability` | session | `{ monthAvailabilityPct, statusUrl }` — the line on an organization's billing page |
| POST | `/api/platform-status/samples` | probe token | an external vantage point's results (see below) |
| POST | `/api/platform-status/deploys` | probe token | `{ imageTag, note? }` — a deploy marker on the timeline (the API also records one for itself at boot) |
| GET | `/api/platform-status/console` | root | the public payload plus burn rates, error budget, p95 latency, error rate, deploys, the latest samples, host events, the setup state, subscriber counts and the component ids an incident may list |
| POST | `/api/platform-status/incidents` | root | `{ title, status?, impact?, components?, startedAt?, excludedFromSlo?, text? }` — `components` may name probes (`api`, `auth`, …) or tracked components (`provisioning`, `backups`, `billing`, `website`, `email`); confirmed subscribers are mailed |
| PATCH | `/api/platform-status/incidents/:id` | root | the same fields; a status change or a `text` appends an update and mails subscribers; `RESOLVED` stamps `resolvedAt` |
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

## Monthly records

Every five minutes the roll-up also writes `platform_slo_months`: one row per month and indicator with the observed and down minutes, the availability, the target, the worst daily p95 and the number of incidents that started in the month (maintenance excluded). The current and the previous month are recomputed on each pass; once a month has ended its `closed_at` is set and the figure is final. The status page at `https://status.<domain>/` reads these through `history` and lets visitors step through the months (`?month=YYYY-MM`).

## Subscriptions

`platform_status_subscribers` holds one row per address with a random token. A subscription is pending until the address opens the confirmation link; every incident mail carries an unsubscribe link with the same token. Mail goes out, to confirmed addresses only, when an incident opens (by the probes or by hand), gets an update with text or a status change, and when it resolves. Sending runs in the background in batches of 20 and never blocks the incident itself; the API log records `mailed n/m subscribers`.
