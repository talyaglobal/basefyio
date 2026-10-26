# Availability: what is measured and how

basefyio measures its own availability from the outside, the way a customer experiences it, and
publishes the result. This page defines the indicators, how a minute counts as down, and the
targets. The compensation policy at the end is a **draft**: it becomes a commitment only when it
is published on the pricing page.

## Indicators

| Indicator | Probe (every 30 seconds, from at least two vantage points) | Target |
|---|---|---|
| **API** | `GET https://api.<domain>/api/health/ready` answers 200 within 3 s, and a keyed REST read on the canary project answers 200 within 1 s | 99.97 % |
| **Dashboard** | `GET https://app.<domain>/login` answers 200 within 3 s | 99.9 % |
| **Auth** | `GET https://auth.<domain>/realms/master/.well-known/openid-configuration` answers 200 within 3 s | 99.97 % |
| **Database endpoint** | a TLS connection to `db.<domain>:6432` and `SELECT 1` on the canary database within 2 s | 99.97 % |
| **Storage** | `GET` of a public probe object answers 200 within 3 s | 99.9 % |
| **Realtime** | a stream on the canary project delivers its first frame within 5 s | 99.9 % |
| **API latency** | p95 of the canary REST read | under 300 ms |
| **Error rate** | share of 5xx answers on the REST, SQL and auth routes per 5-minute window | under 0.1 % |

The **canary** is a real project, owned by the platform, with one table, one public object and
one realtime binding. It is never put to sleep, so a probe failure can only mean the platform
failed, not that the canary was idle.

## Counting

- A **minute is down** for an indicator when the majority of the vantage points that reported in
  that minute failed the probe. One slow probe from one place does not count.
- A minute nobody observed (the prober itself was off) is neither up nor down.
- Availability for a period is observed minutes minus down minutes, over observed minutes.
- **Maintenance** announced at least 48 hours ahead on the status page is excluded. Everything else
  counts, including deploys: a deploy is shown on the timeline as an explanation, never as an
  excuse.
- Targets apply to the calendar month and to the rolling 30 days. 99.97 % of a 30-day month leaves
  **12 minutes 58 seconds** of unavailability; 99.9 % leaves 43 minutes.

## Where it is published

- The public status page shows, per indicator, the current state, the last 90 days as a bar, and
  the availability figures for the current month and the last 90 days, with open and past
  incidents and scheduled maintenance.
- The root console's Reliability page shows the same data with the remaining error budget, the
  burn rate over the last hour, six hours and day, deploy markers, the probe detail and the incident
  editor.
- Each organization's billing page shows the platform's availability for the current month.

## Compensation policy (draft, not yet in force)

- Covered on paid plans: API, Auth and the Database endpoint at 99.97 %; Dashboard and Storage at
  99.9 %. The Free plan carries no credits.
- Credits per calendar month, as a share of that month's fee for the affected organization:
  below 99.97 % → 10 %; below 99.5 % → 25 %; below 99.0 % → 50 %. A credit is applied to the next
  invoice.
- Excluded: announced maintenance (at most 4 hours a month, outside 09:00–18:00 CET), causes on
  the customer's side, force majeure, a dedicated instance failing because of the customer's own
  sizing choice, and the first request that wakes a deactivated project (its wake latency is not
  downtime).

The policy is offered to customers once the platform runs on redundant nodes; until then this page
reports the truth without promising it.
