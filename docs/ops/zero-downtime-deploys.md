> **Hosted platform (28 November 2026):** production no longer runs on Docker Compose. It runs on a Kubernetes cluster where the
> same goal is met by Deployments with `maxUnavailable: 0`, `maxSurge: 1`, readiness probes, two replicas behind a PodDisruptionBudget
> and a 10 s `preStop` wait, so an old pod keeps answering until the ingress has dropped it. This page describes the Docker Compose
> flow that self-hosted installations use.

# Deploys without a gap

The target is 99.99% uptime: about 4.4 minutes a month. A deploy must not take the site, the
dashboard or the API down.

## What went wrong before

`docker compose up -d` stops the old container and then creates the new one. While the new one boots
(10–60 s for a Next.js or Nest app) the proxy has nothing to send traffic to. Traefik first answers a
bare `404 page not found` (a route disappears with its container), then `502`/`503`.

## What the deploy does now

`scripts/ops/rolling-up.sh platform-api admin-ui website`, called by the deploy workflow before its
final `up -d`:

1. starts a second container of the service from the new image, beside the running one;
2. waits until it answers the same path the proxy probes (`/api/health/ready`, `/login`, `/`);
3. waits one proxy health-check interval, so the proxy has it;
4. stops the old container (the API drains on SIGTERM) and removes it;
5. gives the survivor the canonical name (`kolaybase-platform-api-1`), because tools and runbooks use it.

If the new container never answers, it is removed, the old one keeps serving, and the script exits
non-zero; the deploy's plain `up -d` then completes the release the old way (with a gap) and the log
carries `::warning::rolling update did not finish`.

`ROLL_DRY_RUN=1 scripts/ops/rolling-up.sh <service>…` prints what it would do and changes nothing.

## Rules the script depends on

- **The `traefik.*` labels of a service must be identical between two releases.** Two containers that
  define the same router differently make Traefik drop it: the route answers 404 for as long as both
  run (measured: 1190 of 1812 requests). The script compares the labels and refuses to roll a service
  whose labels changed; that service is replaced the plain way, so ship a label change in a
  maintenance window.
- **Database changes must only add.** Old and new API code run together for about a minute. For
  `platform-api` the script rolls only when `deploy/components.env` says
  `BASEFYIO_DB_CHANGES=none` or `additive`.
- Postgres and Keycloak are never rolled here; their restarts stay a planned decision.

## Measured (test server, Traefik 3.6 in front of a service that needs 20 s to boot, ~16 requests a second)

| Replacement | Requests | Failed |
|---|---|---|
| plain `docker compose up -d` | 1782 | 316 (17.7%) |
| rolling-up.sh, labels unchanged | 1758 | 26 (1.5%) |
| rolling-up.sh, labels unchanged, plus a retry middleware and 3 s health checks | 1748 and 1731 | 0 and 1 |
| rolling-up.sh when the labels changed (what the script now refuses) | 1812 | 1190, all 404 |

The remaining failures without the retry middleware are requests that reach the old container in the
seconds before the proxy drops it. The retry middleware (`retry.attempts=4`, `initialinterval=150ms`
on each service's own labels) sends a request that cannot connect to the next server. It is a label
change, so it ships in a window.

## Testing a change to this path

Never first on production. On a spare Docker host: Traefik, one service that sleeps 20 s before it
answers, a request loop through the proxy, then run the script and count the failures. The numbers
above came from that.
