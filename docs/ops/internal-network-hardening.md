# Internal network hardening: Redis AUTH, RabbitMQ credentials, Docker API proxy

Rollout runbook for production-shaped installs (`docker-compose.prod.yml`).
Self-hosted installs that use `scripts/install.sh` get the same result from
`scripts/install.sh upgrade`; see docs/guides/self-hosting-offline.md.

## What changes

| Before | After |
|---|---|
| `redis` and `redis-queue` accept any caller on the internal network | Both start with `--requirepass` (`REDIS_PASSWORD`, `REDIS_QUEUE_PASSWORD`); a caller without the password gets `NOAUTH` |
| RabbitMQ falls back to the published `basefyio` / `basefyio_bus` | `RABBITMQ_USER` / `RABBITMQ_PASSWORD` are required; the API fills them into `MESSAGE_BUS_URL` |
| `platform-api` mounts `/var/run/docker.sock` read-write | `platform-api` reaches Docker only through `docker-proxy` (tecnativa/docker-socket-proxy v0.5.0, pinned by digest) on the internal-only `docker-api` network, which no other container joins |

The compose files refuse to start without the four variables
(`required variable REDIS_PASSWORD is missing a value: …`). Compose checks this
before it touches any container, so a missing variable stops a deploy, never
the running stack.

## Persistence: nothing is lost by the restarts

| Service | Volume | How it survives a restart |
|---|---|---|
| `redis` (cache, rate limits, realtime fan-out, presence, replay buffers) | `redis_data` | RDB snapshots (`--save 60 1000 --save 300 100`) plus a final save on shutdown. Everything in it can be rebuilt; losing it costs a cold cache, never data. |
| `redis-queue` (BullMQ queues, `basefyio:cron-leader` lease, boot-task claims, `usage:*` billing counters, message-bus dedupe keys) | `redis_queue_data` | Append-only file, `appendfsync everysec`, `noeviction`. A clean stop flushes the AOF, so queued jobs, delayed jobs and usage counters come back exactly as they were. |
| `rabbitmq` | `rabbitmq_data` | Users, vhost and quorum queues live in the volume; `hostname: rabbitmq` keeps the node name, so the recreated container opens the same data. |

## Docker API allow-list

Derived from every Engine API call in platform-api (inventory below). Every
section not listed answers 403.

| Proxy switch | Value | Needed by |
|---|---|---|
| `POST` | 1 | Every write below. Without it the proxy is read-only and dedicated databases, PITR restores and the Supabase schema dump all fail. (Also covers DELETE.) |
| `CONTAINERS` | 1 | `GET /containers/json` (capacity sampler), `GET /containers/{id}/json` (infrastructure status, boot reconcile, PITR progress), `GET /containers/{id}/stats` (capacity sampler), `GET /containers/{id}/logs` (PITR and Supabase import error tails), `POST /containers/create` + `/start` (dedicated Postgres / MinIO, PITR throwaway postgres, pg_dump container), `POST /containers/{id}/stop`, `POST /containers/{id}/wait` (Supabase import), `DELETE /containers/{id}` |
| `VOLUMES` | 1 | `POST /volumes/create`, `DELETE /volumes/{name}` (dedicated databases), `GET /volumes` (root console disk page) |
| `EXEC` | 1 | `POST /containers/{id}/exec` (matched by `CONTAINERS`) + `POST /exec/{id}/start`, `GET /exec/{id}/json`: PITR runs `psql` and `pg_dump` inside the recovery postgres |
| `IMAGES` | 1 | `POST /images/create`: the Supabase import pulls `postgres:<major>-alpine` for its pg_dump |
| `INFO` | 1 | `GET /info` (`DockerRootDir`, root console disk page) |
| `SYSTEM` | 1 | `GET /system/df` (root console disk page) |
| `PING`, `VERSION` | 1 | `GET /_ping` at boot (infrastructure service), API version negotiation |
| `EVENTS`, `NETWORKS`, `ALLOW_START/STOP/RESTARTS` | 0 | Not used (`NetworkMode` is part of the create body, not a networks call; start/stop are already covered by `CONTAINERS` + `POST`) |
| `AUTH`, `BUILD`, `COMMIT`, `CONFIGS`, `DISTRIBUTION`, `GRPC`, `NODES`, `PLUGINS`, `SECRETS`, `SERVICES`, `SESSION`, `SWARM`, `TASKS` | 0 | Not used |

Callers: `modules/infrastructure/infrastructure.service.ts`,
`modules/projects/project-pitr.service.ts`,
`modules/projects/supabase-import.service.ts`,
`modules/capacity/capacity-sampler.service.ts`,
`modules/root-console/disk-usage.service.ts`. All of them build their client
through `common/docker/docker-connection.ts` from `DOCKER_HOST`.

**What the proxy does not stop.** The proxy filters by path and method, not by
request body. Because dedicated databases, PITR and the Supabase import must
create containers, a compromised platform-api can still ask for a privileged
container or a host bind mount through `POST /containers/create`, which is
root on the host. Filtering the body with a regex in HAProxy is not a real
control (Docker's JSON decoder accepts escaped and case-folded keys), so it was
not added. What the proxy does give: no other container can reach Docker at all
(before, anything that got into platform-api's filesystem had the socket; now
the API holds no socket and the proxy sits on a network with exactly one
client), and build, plugins, swarm, secrets, registry auth, commit and events
are closed. Closing the create path needs either a Docker authorization plugin
that inspects the create body (for example the open-source
`openpolicyagent/opa-docker-authz`: deny `Privileged`, `CapAdd`, host-path
binds, `host` network/PID modes) — a Docker daemon change on the host — or
moving container creation into a separate narrow service. Both are owner
decisions and not part of this change.

Traefik still mounts the socket `:ro`. A read-only bind mount does not limit
the API calls made through the socket; moving Traefik onto a second, read-only
proxy (`CONTAINERS=1`, `NETWORKS=1`, `EVENTS=1`, `POST=0`) is a follow-up. It
recreates Traefik, which briefly drops every route, so it is not bundled here.

**Not verified without a host.** HAProxy (the proxy) streams the non-hijacked
`POST /exec/{id}/start` response and the long-poll `POST /containers/{id}/wait`
the way the socket does; its `timeout server` is 10 minutes, which bounds a
Supabase schema dump through the proxy. Verify both on the first rollout
(step 5) before relying on them.

## Rollout

Two releases, so that no running API ever talks to a Redis that wants a
password it does not have:

- **Release A** ships the API code, the `docker-proxy` service, the required
  RabbitMQ pair and the Redis passwords *in the API's environment only*. Redis
  still accepts callers without a password; ioredis notices that the server
  needs none and carries on with a one-line warning.
- **Release B** adds `--requirepass` to `redis` and `redis-queue`. The API from
  release A already authenticates, so when the deploy restarts Redis the
  clients reconnect with AUTH and nothing fails beyond the reconnect itself.

All commands run in the install directory on the server, as one batch per step.
`dc` below stands for
`docker compose -f docker-compose.prod.yml --env-file .env.production`.
Never use a bare `docker compose` (it picks the development file), and never
recreate `keycloak` or `postgres` here.

### 1. Pre-flight (read only)

```bash
dc ps
df -h /                                   # must stay below 90 %
dc logs --since 30m platform-api | grep -c 'Payment probe failing'   # must be 0
# Which of the variables exist already (names only, never values):
grep -oE '^(REDIS_PASSWORD|REDIS_QUEUE_PASSWORD|REDIS_QUEUE_URL|RABBITMQ_USER|RABBITMQ_PASSWORD|MESSAGE_BUS_URL|DOCKER_HOST)=' .env.production
grep -E '^MESSAGE_BUS_URL=.*@' .env.production >/dev/null && echo "MESSAGE_BUS_URL carries credentials" || echo "MESSAGE_BUS_URL has none (or is empty)"
# Persistence really is on:
dc exec -T redis-queue redis-cli CONFIG GET appendonly            # appendonly yes
dc exec -T redis redis-cli CONFIG GET save                        # 60 1000 300 100
# Baseline to compare after each release:
dc exec -T redis-queue redis-cli DBSIZE
dc exec -T redis-queue redis-cli --scan --pattern 'usage:*' | wc -l
dc exec -T redis-queue redis-cli --scan --pattern 'bull:*:wait' | wc -l
dc exec -T rabbitmq rabbitmqctl list_users                        # the user the broker has
```

### 2. Secrets (before release A is merged)

```bash
cp -p .env.production ".env.production.bak-$(date +%Y%m%d%H%M)"
NEW_RMQ="$(openssl rand -hex 32)"
{
  printf '\nREDIS_PASSWORD=%s\n'       "$(openssl rand -hex 32)"
  printf 'REDIS_QUEUE_PASSWORD=%s\n'   "$(openssl rand -hex 32)"
} >> .env.production
# Only if step 1 showed no RABBITMQ_USER: the user the broker already has.
grep -q '^RABBITMQ_USER=' .env.production || printf 'RABBITMQ_USER=basefyio\n' >> .env.production
```

Hex values need no quoting in the env file and no escaping in a URL. Use two
different Redis passwords.

**RabbitMQ.** `RABBITMQ_DEFAULT_PASS` is applied only to an empty data volume,
so the running broker keeps its old password until it is changed in place.
Change it first, then write the same value:

```bash
U="$(grep -E '^RABBITMQ_USER=' .env.production | cut -d= -f2-)"
dc exec -T rabbitmq rabbitmqctl change_password "$U" "$NEW_RMQ"
dc exec -T rabbitmq rabbitmqctl authenticate_user "$U" "$NEW_RMQ"     # "Success"
sed -i '/^RABBITMQ_PASSWORD=/d' .env.production
printf 'RABBITMQ_PASSWORD=%s\n' "$NEW_RMQ" >> .env.production
# A MESSAGE_BUS_URL with credentials inside would win over the new variables:
sed -i 's#^MESSAGE_BUS_URL=amqp://[^@]*@#MESSAGE_BUS_URL=amqp://#' .env.production
unset NEW_RMQ
```

Connections the running API already holds stay open after
`change_password`; only new connections need the new value, and the API that
release A starts brings it. With `MESSAGE_BUS_URL` empty the bus is inert and
none of this affects traffic.

The variables are unused by the release that is running now, so writing them
changes nothing until the next deploy.

### 3. Check what release A will recreate (before merging)

```bash
git fetch -q origin
git show origin/<release A commit>:docker-compose.prod.yml > /tmp/compose.next.yml
docker compose -p "$(basename "$PWD")" --project-directory "$PWD" -f /tmp/compose.next.yml \
  --env-file .env.production config -q && echo "config ok"
docker compose -p "$(basename "$PWD")" --project-directory "$PWD" -f /tmp/compose.next.yml \
  --env-file .env.production up -d --dry-run 2>&1 | grep -Ei 'recreate|create|start'
```

Expected: `docker-proxy` created, `rabbitmq` and `platform-api` recreated
(admin-ui and website follow their new image tag as in every deploy). `keycloak`,
`postgres`, `minio`, `pgbouncer`, `mongodb`, `traefik`, `redis` and
`redis-queue` must **not** appear. If keycloak or postgres appears, stop.

### 4. Ship release A

Through the normal flow (`/ship`: development → main → production). The deploy
runs the full `dc up -d --remove-orphans`, which recreates only what step 3
listed.

Expected blip: RabbitMQ restarts (30–60 s until healthy; quorum queues and
messages persist in `rabbitmq_data`; the bus reconnects). The API restart is the
usual deploy drain (25 s) and boot. Redis is not restarted.

### 5. Verify release A

```bash
dc ps docker-proxy platform-api rabbitmq
curl -s https://api.<domain>/api/health | head -c 600; echo     # status ok, redis ok
dc logs --since 10m platform-api | grep -E 'Docker client connected|Docker not available'
#   expect: Docker client connected (http://docker-proxy:2375)
dc logs --since 10m platform-api | grep -c 'does not require a password'   # > 0 is expected in A
docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' $(dc ps -q platform-api) | grep -c docker.sock   # 0
# The proxy refuses what is not on the list, and serves what is:
dc exec -T platform-api node -e "fetch('http://docker-proxy:2375/info').then(r=>console.log('info',r.status))"        # 200
dc exec -T platform-api node -e "fetch('http://docker-proxy:2375/build',{method:'POST'}).then(r=>console.log('build',r.status))"   # 403
dc exec -T platform-api node -e "fetch('http://docker-proxy:2375/plugins').then(r=>console.log('plugins',r.status))"  # 403
# Nobody else reaches the proxy:
dc exec -T admin-ui sh -c 'wget -q -T 3 -O- http://docker-proxy:2375/_ping || echo unreachable'   # unreachable
```

Then exercise the Docker paths once: open the root console's disk page (Docker
images / build cache sizes must be filled), and if the capacity sampler is on,
check its container rows. A PITR restore and a Supabase import exercise `exec`
and `wait` through the proxy; run one on a test project before you need one.

If the bus is on: `dc logs --since 10m platform-api | grep -i 'message bus'`
shows it connected, and `dc exec -T rabbitmq rabbitmqctl list_connections user`
lists the API.

Compare the step 1 baseline: `DBSIZE`, `usage:*` and `bull:*:wait` on
`redis-queue` must be the same or higher (they were never restarted).

### 6. Ship release B

Same flow. Step 3's dry run for B lists `redis` and `redis-queue` (and the
platform images); still never keycloak or postgres.

Expected blip: each Redis instance stops (final RDB save / AOF flush) and starts
again from its volume, a few seconds each. The API's clients reconnect with the
password they already send; commands issued meanwhile wait in ioredis's offline
queue. BullMQ workers resume where they were; the cron-leader lease
(`basefyio:cron-leader`, on `redis-queue`) is still there after the restart, so
the same replica keeps leading or re-acquires within one lease period. Realtime
SSE connections stay open (they are held by the API, not Redis); events
published during the few seconds of reconnect are not fanned out to other
replicas (with `API_REPLICAS=1` there is no other replica).

### 7. Verify release B

```bash
dc exec -T redis sh -c 'unset REDISCLI_AUTH; redis-cli ping'          # NOAUTH Authentication required.
dc exec -T redis-queue sh -c 'unset REDISCLI_AUTH; redis-cli ping'    # NOAUTH Authentication required.
dc exec -T redis redis-cli ping                                       # PONG (REDISCLI_AUTH)
dc ps redis redis-queue                                               # healthy
curl -s https://api.<domain>/api/health | head -c 600; echo           # redis ok
dc logs --since 10m platform-api | grep -Ei 'NOAUTH|WRONGPASS' | head  # nothing
dc exec -T redis-queue redis-cli DBSIZE                               # >= baseline
dc exec -T redis-queue redis-cli --scan --pattern 'usage:*' | wc -l   # >= baseline
dc logs --since 15m platform-api | grep -c 'Payment probe failing'    # 0
```

Then send yourself a test e-mail from the dashboard (goes through the BullMQ
`email` queue).

## Rollback

- **Release B → A** (Redis without a password again): revert the release-B
  commit and ship, or by hand with the release-A compose file:
  `dc up -d --no-deps redis redis-queue`. The API keeps sending the password and
  keeps working. Data stays in the volumes.
- **Release A → before**: ship the previous commit, or
  `IMAGE_TAG=<previous sha> dc up -d --no-deps platform-api` with the previous
  compose file checked out. The added variables can stay in `.env.production`;
  the old release ignores them. The previous compose file mounts the socket
  again by itself.
- **RabbitMQ password**: the old release falls back to `basefyio_bus` only for
  an *empty* volume, so after a rollback keep `RABBITMQ_PASSWORD` in
  `.env.production` and set `MESSAGE_BUS_URL=amqp://<user>:<new password>@rabbitmq:5672`
  if the bus is on, or change the password back with
  `rabbitmqctl change_password <user> basefyio_bus`.
- **Proxy only** (a Docker feature fails through the proxy): add
  `-f deploy/compose/docker-socket-direct.yml` to the compose command; the API
  mounts the socket as before. Record which call failed and widen the allow-list
  deliberately instead of keeping the opt-out.
- `.env.production.bak-*` from step 2 is the exact previous env file.

## Risks

- **RabbitMQ restart in release A.** If the bus is on, publishes during the
  30–60 s restart fail and are retried by the caller where it retries; the
  dedupe keys on `redis-queue` prevent double handling on redelivery.
- **Requests that hit a Redis-backed rate limit while Redis reconnects** (B,
  a few seconds): the global throttler and admission control fall back to
  in-memory counting; the per-route `RateLimitGuard` (sign-in, codes) answers
  500 for that moment.
- **A dedicated database marked FAILED by a proxy refusal**: prevented in code —
  only a 404 from Docker counts as "container missing"; a 403 or an unreachable
  proxy reads as "unknown" and is left alone.
- **The proxy starts after the API**: the API retries the Docker ping every 10 s
  for five minutes instead of disabling dedicated infrastructure until the next
  restart.
- **Secrets on the command line**: `--requirepass` is visible to
  `docker inspect` on the host, like every other secret in the compose
  environment. It is not visible to other containers.
