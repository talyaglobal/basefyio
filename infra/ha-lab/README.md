# Postgres HA lab (Stage 0 rig)

A local rig for the Postgres high-availability programme (feedback #229, #230, #231). It proves on a
developer machine what later stages change in production: streaming replication on the production
cluster image, a stable `pg-rw` / `pg-ro` endpoint, and a promotion that Keycloak and PgBouncer survive
without a restart.

**Never deployed.** Nothing in the deploy workflow, the installer or `docker-compose.prod.yml` refers to
this directory. `lab.sh` refuses to run against a remote Docker daemon or a daemon that runs the
production stack.

## What runs

| Service | Image | Role |
|---|---|---|
| `pg-primary`, `pg-replica` | the production cluster image by digest, `ghcr.io/fsipka/basefyio-postgres@sha256:a8083c2a…6eb9` | Primary and streaming standby. Same `command:` as production plus the Stage 1 HA parameters (`max_wal_senders=10`, `max_replication_slots=10`, `max_slot_wal_keep_size=2GB`, `wal_log_hints=on`, `hot_standby=on`, `hot_standby_feedback=on`, `max_standby_streaming_delay=30s`). |
| `rc-primary`, `rc-replica` | built from `role-check/` (Alpine 3.20 + `psql` + `socat`) | `pg-role-check`: HTTP on :8008, `/primary` is 200 only on a primary, `/replica[?lag=bytes]` is 200 only on a streaming standby within the lag. The same paths Patroni serves, so HAProxy's checks do not change at Stage 5. |
| `haproxy` | `haproxy:3.0.31-alpine` (digest-pinned) | `pg-rw:5432` → the node answering `/primary`; `pg-ro:5433` → standbys answering `/replica?lag=16777216`, falling back to `pg-rw` when none is healthy. `on-marked-down shutdown-sessions` cuts clients off a node the moment it stops being primary. |
| `pgbouncer` | `edoburu/pgbouncer:v1.25.1-p0` (digest-pinned) | Same settings the API generates in production (transaction mode, `auth_type = plain`), with every `[databases]` line pointing at `pg-rw`, so a promotion needs no `RELOAD`. |
| `keycloak` | `quay.io/keycloak/keycloak:24.0.5` (digest-pinned) | The production major (24). `KC_DB_URL=jdbc:postgresql://pg-rw:5432/keycloak`, and it depends on `haproxy`, not on a Postgres node. |
| `client` | the cluster image | `psql` for `lab.sh` and `smoke.sh`; the host needs no Postgres client. |

### How the nodes bootstrap

Both nodes use `node-entrypoint.sh`, which follows production's convention: prepare
`/var/lib/postgresql/wal_archive` as root, then `exec docker-entrypoint.sh` with the compose `command:`.

- **Primary (first start):** the image runs initdb, then `/docker-entrypoint-initdb.d/`:
  `01-init.sql` is production's `scripts/init-db.sql` (creates the `keycloak` database), and
  `10-lab-roles.sh` creates `replicator` (`REPLICATION LOGIN`), `rolecheck` (`pg_monitor`) and the
  `labdb` database. It appends production's replication rule, `host replication all samenet scram-sha-256`.
- **Standby:** when its data directory is empty and `state/<node>.upstream` names the other node, the
  wrapper runs `pg_basebackup --wal-method=stream --create-slot --slot=slot_<node> --write-recovery-conf`.
  That writes `standby.signal`, `primary_conninfo` and `primary_slot_name` into `postgresql.auto.conf`.
  `hot_standby=on` is in the shared command.
- **Fencing:** `lab.sh promote` writes `state/<old primary>.fenced`. A fenced node with a data
  directory refuses to start, so the old primary can never come back as a second writable primary.
  `lab.sh failback` wipes it and reseeds it as a standby.

The lab connects a standby straight to the other node. In production (Stage 2) the standby connects
through host 1's private HAProxy listener with `sslmode=require` and a passfile instead of the
password `pg_basebackup -R` writes.

## Requirements (owner's machine)

- Docker Desktop (or Colima/OrbStack) with Compose v2, about 3 GB free memory, and ports 15432,
  15433, 16432, 17000 and 18080 free on 127.0.0.1.
- `curl` on the host.
- Access to the production cluster image: `docker login ghcr.io` with an account that can read
  `fsipka/basefyio-postgres` (the package is private). Without that login, build the image locally:
  `./lab.sh build-image`, then prefix `up` with `LAB_PG_IMAGE=basefyio-postgres:lab`. A local build
  uses the same Dockerfile, but its apt PostGIS version is not pinned, so it is not byte-identical to
  production. Use the digest for any result that claims production parity.

## Run it

```bash
cd infra/ha-lab
./lab.sh check          # compose config + `haproxy -c` (pulls the haproxy image), starts nothing
./lab.sh up             # 2–5 min on the first run (image pulls, Keycloak's first build)
./lab.sh status         # roles, pg_stat_replication, slots, where pg-rw / pg-ro land, Keycloak
./smoke.sh              # the Stage 0 acceptance test (below); ends with the lab promoted
./lab.sh status         # pg-replica is the primary, pg-primary is stopped and fenced
./lab.sh failback       # rebuild pg-primary as a standby, switch back, rebuild pg-replica
SMOKE_MODE=--crash ./smoke.sh   # the same test with the primary killed instead of stopped
./lab.sh failback
./lab.sh down           # removes the lab's containers, its volumes and ./state
```

`./lab.sh psql pg-rw` (or `pg-ro`, `pgbouncer`, `pg-primary`, `pg-replica`) opens psql on `labdb`.
HAProxy's stats page is at <http://127.0.0.1:17000/>. Credentials are generated on the first `up` into
`state/lab.env` (gitignored); the Keycloak admin is `admin` with `LAB_KC_ADMIN_PASSWORD`.

## What `smoke.sh` proves

1. A write through `pg-rw` and one through PgBouncer land on `pg-primary`.
2. Both rows are readable through `pg-ro`, which lands on the standby, and the standby refuses a write.
3. An admin login to Keycloak works; the container's start time and restart count are recorded.
4. `lab.sh promote`: fence the primary (clean stop, or `docker kill` with `SMOKE_MODE=--crash`), then
   `pg_ctl promote` on the standby, and wait until `pg-rw` follows it.
5. Writes through `pg-rw` and PgBouncer reach the new primary (the attempt count and seconds are
   printed), with no PgBouncer `RELOAD`, and every earlier row of the run is there. `pg-ro` falls
   back to the primary.
6. Keycloak was **not restarted** (same start time and restart count), `/health/ready` answers, the
   pre-promotion session refreshes, a new login works, and an admin write (create user) lands in the
   `keycloak` database on the new primary. The seconds until that first write are the figure Stage 1
   needs; if Keycloak's Agroal pool never recovers, the test fails and the plan's fallback applies
   (datasource validation properties set during MW-1's Keycloak restart).

Exit code 0 only when every check passes.

## What this lab does not cover yet

- Patroni, etcd and the witness (Stage 5); `promote` and `failback` are the manual runbook's steps.
- The platform API image and its raw `pg.Pool`s (finding 3; covered once #232's pool factory exists).
- WAL archiving on the promoted node (Stage 4); the lab archives to a local volume per node only.
- TLS on the replication connection and the cross-server firewall (Stage 2).
- pg_cron behaviour across a switchover (#210; needs the MW-1 image).
