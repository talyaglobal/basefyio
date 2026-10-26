# Host operations scripts

The pieces that keep a basefyio host healthy between deploys. They run on the
host, not in a container, as systemd timers (`../systemd/`). Each one is the
copy of what production runs; the host is configured through environment
variables rather than edits, so the next node gets the same scripts unchanged.

| Script | Runs | What it does |
|---|---|---|
| `../storage-autopilot.py` | every minute (`basefyio-storage-autopilot.timer`) | Grows the data volume before it fills, writes `events.jsonl`, mails the operator. The root console's red alert bar reads its state. |
| `disk-guard.sh` | daily (`basefyio-disk-guard.timer`) | Prunes reproducible Docker data only — build cache, unused images, stopped containers, oversized logs. Never volumes. **It removes image tags nothing references**, so a pipeline that builds ahead of use must not rely on the tag surviving. |
| `postgres-pin.sh` | once, in a window the operator chooses (`basefyio-postgres-pin.timer`) | Rebuilds the cluster image from `docker/postgres/Dockerfile` on `PIN_BRANCH`, recreates **only** the Postgres container (`--no-deps`, Keycloak untouched), and verifies: healthy → project row count → glibc unchanged → an index probe that catches a collation change → HTTPS → Keycloak container unchanged. Anything short of that rolls back to the previous image. The outcome lands in the autopilot's event log, so it shows in the console. |

## Configuration (environment of the systemd unit)

| Variable | Default | Used by |
|---|---|---|
| `BASEFYIO_DEPLOY_DIR` | `/root/kolaybase` | both — where the checkout and `.env.production` live |
| `OPS_ALERT_TO` | — (required for mail) | `postgres-pin.sh` — the operator address; may also be set in `.env.production` |
| `PIN_BRANCH` | `main` | `postgres-pin.sh` — the branch (on `origin`) whose `docker/postgres/Dockerfile` is built |

Mail goes through the same provider the API uses (`RESEND_API_KEY` or
`TSMART_SEND_API_KEY`, `RESEND_FROM_EMAIL`, optional `RESEND_BASE_URL` in
`.env.production`) with an explicit User-Agent — Cloudflare-fronted providers
refuse the library default.

## Lessons these scripts encode

- Capture nothing from a `psql` call that also echoes `SET`; planner flags go
  through `PGOPTIONS="-c …"` and a captured value that is not a number aborts
  the run. The first pin run rolled back a good image because `SET\n0` was
  read as the probe result.
- A Postgres image keeps its libc or is followed by a `REINDEX`: the probe
  with `enable_seqscan=off` finds the rows a corrupted text index would miss.
- The deploy tags the Postgres image by the Dockerfile's hash and labels the
  container with it; a pin that leaves `main` carrying the same Dockerfile
  means the next deploy finds the image already built and leaves Postgres alone.
