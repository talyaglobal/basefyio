# Self-hosting, including hosts without internet access

basefyio runs entirely from containers. `scripts/install.sh` installs, reconfigures,
upgrades and rolls back a self-hosted stack: it asks which release and which
components to run, writes the env file and the compose files to use, and starts
everything. This guide covers it end to end, including a host that cannot reach
any registry: bundling the images on a connected machine, carrying them over,
serving HTTPS with your own certificate, and starting without a single network call.

---

## What you need

| Where | What |
|---|---|
| The host | Docker Engine with Compose **2.24 or newer**, git, bash 4+, a checkout of this repository |
| Offline only: a connected machine | The same, plus registry access, to build the image bundle |
| Free disk | The images (several GB), the data, and room for one database backup before every upgrade |

Two compose files are supported:

- **`docker-compose.yml` — self-host (default).** Builds the API, dashboard and
  website from source and pulls PostgreSQL, Keycloak, Redis, MinIO and PgBouncer.
  Plain HTTP on local ports, plus an opt-in TLS proxy with your own certificate.
- **`docker-compose.prod.yml` — production-shaped.** The layout basefyio's cloud
  runs: Traefik with Let's Encrypt, images pulled from the basefyio registry (a
  registry login is needed) or built from source.

---

## 1. Install

```bash
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
scripts/install.sh
```

The installer asks one question at a time. Every question has a default, and the
default is what an installation does today — pressing Enter through all of them
on an existing installation changes nothing.

| Question | Answers (default first) | What it changes |
|---|---|---|
| Compose file | `selfhost`, `prod` | which file the stack runs from; an existing `.env` / `.env.production` decides the default |
| Release | newest release tag, any tag from `v2.9.6` on, or `current` | the installer checks the tag out and continues with that release's own installer; the release is written to `IMAGE_TAG` and reported by `GET /api/health` |
| Platform images | `build` (self-host) / `pull` (production-shaped), `bundle` | build from the checkout, pull from the registry, or load a bundle (step 3) |
| Keycloak | `24`, `26`, `external` | the bundled Keycloak version, or none: then you give the URL the API calls, the URL browsers see, a master-realm admin user and password, and optionally its readiness URL |
| Direct Postgres role | `no`, `yes` | creates a role with `CREATEDB` and `CREATEROLE` (not a superuser) and publishes Postgres on `127.0.0.1:5432` (configurable), beside PgBouncer — for an application that manages its own databases and roles and sends connection-time settings such as `-c TimeZone=UTC -c jit=off`, which PgBouncer's transaction mode refuses |
| PgBouncer port | `all`, `local`, `closed` | all interfaces (today), `127.0.0.1` only, or not published at all |
| Document store | `yes`, `no` | `no`: the document store (MongoDB in the production-shaped file, Couchbase and its initialiser in the self-host file) does not start and publishes no ports; the Data Engine keeps documents in PostgreSQL |
| AI features | `on`, `off` | `off` (`AI_ENABLED=false`): the assistant, agents, embeddings, retrieval and recommendations are switched off and no request goes to OpenAI, Anthropic, Cohere, fal.ai, ElevenLabs or a remote Ollama |
| Platform mail | `resend`, `smtp` | `smtp`: server, port, encryption (`starttls`, `tls`, `none`), user, password and sender; optionally Keycloak's own mail (password reset and verification links of its login pages) uses the same server |
| Offline host | `no`, `yes` | silences optional outbound calls (Prisma, Next.js telemetry, MinIO update check) and starts with `--pull never` |
| Pin component images | `yes` for a new installation, `no` for an existing one | writes the component versions this release is tested with (`deploy/components.env`) into the env file; any you set yourself are kept |

At the end the installer prints the release and its components — default and
supported versions, and whether the release changed the database:

```
Release v2.9.6  (database changes since the previous release: none)
  Component    Default  Supported / pinned
  Keycloak     24       24.0.5 26.8.1
  PostgreSQL   16       pgvector/pgvector:0.8.7-pg16-bookworm (self-host); docker/postgres (production-shaped)
  MinIO                 ghcr.io/…/basefyio-minio:RELEASE.2025-09-07T16-13-09Z | chainguard/minio@sha256:…
  PgBouncer             edoburu/pgbouncer:v1.25.1-p0
  …
```

It also writes `./basefyio`, which is `docker compose` with this installation's
project name, env file and compose files:

```bash
./basefyio ps
./basefyio logs -f platform-api
```

### Answers without questions

Every answer can come from the environment or from a file, for unattended
installs. The variable names are listed at the top of `scripts/install.sh`; the
answers are stored in the env file as `BASEFYIO_*`, so later runs ask nothing
that was answered before.

```bash
cat > answers.env <<'EOF'
BASEFYIO_VERSION=v2.9.6
BASEFYIO_KEYCLOAK=26
BASEFYIO_DOCSTORE=no
BASEFYIO_AI=off
BASEFYIO_MAIL=smtp
SMTP_HOST=mail.internal.example
SMTP_PORT=587
SMTP_SECURE=starttls
SMTP_USER=basefyio
SMTP_PASSWORD=change-me
MAIL_FROM='basefyio <noreply@internal.example>'
KEYCLOAK_REALM_SMTP=true
BASEFYIO_PGBOUNCER_BIND=local
BASEFYIO_DB_ADMIN_ROLE=yes
POSTGRES_APP_ADMIN_USER=app_admin
BASEFYIO_CONFIRM_KEYCLOAK_26=yes
EOF
scripts/install.sh --yes --answers answers.env
```

`--yes` takes the default for anything left unanswered; `--dry-run` prints the
plan without changing anything. A new installation starts from `.env.example`
with every password and key generated.

### The first administrator

A new installation has no platform administrator. Sign up in the dashboard like
any user (the confirmation code arrives by mail), then make that account ROOT:

```bash
scripts/install.sh root you@example.com
```

ROOT opens the console, where you manage users, plans and their limits. On first
start the API creates the default plans (Free, Pro, Business, and an unlimited
Legacy plan that is not offered at sign-up); new organizations start on Free, so
raise its limits in the console if your users need more than five projects each.

### Keycloak 26

Keycloak migrates its own database the first time a newer version starts, and
cannot go back. Moving an existing installation from 24 to 26 therefore asks for
confirmation (`BASEFYIO_CONFIRM_KEYCLOAK_26=yes` when unattended), takes a backup
of every database first, and refuses the reverse direction — returning to 24
means restoring that backup. Everyone signs in again after the switch. From
Keycloak 25 on, its health endpoint lives on the management port 9000; the
installer points the API's health check there.

Keycloak 25 and newer also give the master realm's `admin-cli` client
lightweight access tokens, which carry no `sub` or `email` — and dashboard
sign-in is a password grant on that client. When the API starts it switches
that one setting off on its sign-in client (`KEYCLOAK_ADMIN_CLIENT_ID`,
`admin-cli` by default). This applies to an external Keycloak too, where the
API at boot also raises the master realm's token and session lifespans (30
minutes, 30 days), adds an account-linking login flow and creates its own
`basefyio-platform` client.

### MinIO images

The upstream `minio/minio` image can no longer be pulled anonymously from Docker
Hub. A new installation is pinned to the exact build basefyio's cloud runs,
mirrored to the basefyio registry (when images are pulled with a registry login),
or otherwise to a public MinIO build from Chainguard pinned by digest (a newer
MinIO release, which an empty installation can start on). An existing
installation keeps the MinIO image it already has unless you set `MINIO_IMAGE`.

---

## 2. Upgrade and roll back

```bash
scripts/install.sh upgrade
```

1. Reads the installed release and options from the env file and lists the newer releases.
2. Backs up every database (`pg_dumpall --clean`, gzip) into `backups/<time>-<release>/`
   with the env file, the compose files and the image list — after checking there
   is room for it — and keeps the running images under `basefyio-rollback/*:<release>`.
3. Checks out the new release and continues with that release's installer
   (new questions get their defaults; earlier answers are kept).
4. Builds, pulls or loads the images, starts the stack and waits for the API.
5. If the API does not come up, it rolls back by itself: previous checkout,
   previous env file, the kept images.

The API applies its own schema changes when it starts; there is no separate
migration step, and schema changes are additive, so a rollback of the
application keeps working with the data written in between. Two explicit commands
exist for the cases the automatic rollback does not cover:

```bash
scripts/install.sh rollback               # back to the release before the last upgrade
scripts/install.sh restore backups/<dir>  # put a database backup back — replaces current data
```

`restore` asks for confirmation (`BASEFYIO_CONFIRM_RESTORE=yes` when unattended),
stops everything except PostgreSQL, restores the dump and starts the stack again.
It is the way back after a Keycloak version change. Object storage (MinIO) is not
part of the database backup; copy its volume separately if you need a point-in-time
copy of the files too.

`scripts/install.sh status` shows the release, the previous one, the last backup
and what is running.

---

## 3. Hosts without internet access

### Bundle the images (connected machine)

```bash
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
git checkout v2.9.6            # the release you will run offline

# Self-host file, plus the TLS proxy profile if you will terminate HTTPS with
# your own certificate (see "TLS" below):
./scripts/bundle-images.sh --profile tls -o /tmp/basefyio-images.tar.gz
```

The script builds the services declared with `build:`, resolves every image the
compose file references, pulls what is not present and writes the bundle, a
manifest (`.images.txt`) and a checksum (`.sha256`). To bundle the images a
pinned installation will run, pass the env file the installer wrote:
`./scripts/bundle-images.sh --env-file .env …`. For the production-shaped file:
`./scripts/bundle-images.sh -f docker-compose.prod.yml --env-file .env.production`.

### Carry the files over and install

Copy the tarball, the manifest and the checksum together with the repository
checkout (same commit) to the offline host, then:

```bash
BASEFYIO_IMAGES=bundle BASEFYIO_BUNDLE=/media/transfer/basefyio-images.tar.gz \
BASEFYIO_OFFLINE=yes BASEFYIO_VERSION=current \
scripts/install.sh
```

The installer verifies the checksum, loads the images, checks every name in the
manifest against the local store, and starts with `--pull never`, so a missing
image is a clear error instead of a registry call that hangs.

For an offline host, set the hostnames in the env file (`DOMAIN`,
`PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`, `KEYCLOAK_PUBLIC_URL`) and point them at
the host in your internal DNS. Mail needs an SMTP server on the internal network
(the HTTP mail API is not reachable offline). Features that need an external
service stay off by leaving their variables empty: `GOOGLE_CLIENT_ID` /
`GITHUB_CLIENT_ID` (social sign-in), `STRIPE_SECRET_KEY` (billing), and AI
(`BASEFYIO_AI=off`).

### TLS with your own certificate

Let's Encrypt cannot validate a host it cannot reach, so the self-host file
carries an opt-in reverse proxy that serves a certificate you supply:

- `TLS_CERT_FILE` — the certificate chain in PEM (leaf first, then intermediates)
- `TLS_KEY_FILE` — the matching private key, unencrypted PEM

The proxy mounts both read-only and serves them for every hostname; replace them
on renewal and the new certificate is picked up without a restart. Routes are in
`docker/traefik/dynamic/routers.yml`, the certificate wiring in
`docker/traefik/dynamic/tls.yml`. Clients must trust the issuing CA.

Keycloak must know it sits behind a TLS-terminating proxy. Add an overlay and
pass it to the installer with `BASEFYIO_EXTRA_COMPOSE` (space-separated paths):

```yaml
# keycloak-proxy.yml
services:
  keycloak:
    environment:
      KC_PROXY_HEADERS: xforwarded
      KC_HOSTNAME: auth.basefyio.internal.example
```

```bash
BASEFYIO_EXTRA_COMPOSE=keycloak-proxy.yml scripts/install.sh
```

Start the proxy profile with `./basefyio --profile tls up -d`.

### Verify

```bash
./basefyio exec platform-api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>r.text()).then(console.log)"
# {"status":"ok",…,"release":{"stage":"…","version":"2.9.6"},"checks":{…}}
```

`email.state: not-configured` means mail is off, not that the API is unhealthy.
Then sign in at `https://app.<DOMAIN>/login` (or `http://localhost:3000` without
the proxy) with the Keycloak admin account from the env file.

---

## Manual configuration

The installer only writes the env file and chooses compose files; everything it
does can be done by hand. The overlays live in `deploy/compose/`:

| File | Option |
|---|---|
| `keycloak-26.yml` | Keycloak 26 (image, bootstrap admin, health on port 9000) |
| `keycloak-external.yml` | no bundled Keycloak; `KEYCLOAK_URL`, `KEYCLOAK_PUBLIC_URL` |
| `postgres-direct.yml` | Postgres on `POSTGRES_DIRECT_BIND:POSTGRES_DIRECT_PORT` |
| `pgbouncer-local.yml`, `pgbouncer-closed.yml` | where PgBouncer listens |
| `selfhost/no-docstore.yml`, `prod/no-docstore.yml` | no document store |
| `offline.yml` | no optional outbound calls |
| `prod/build.yml` | build the production-shaped images from the checkout |

```bash
docker compose -p basefyio --env-file .env \
  -f docker-compose.yml -f deploy/compose/keycloak-26.yml -f deploy/compose/pgbouncer-local.yml up -d
```

The environment variables these options set are described in
`docs/reference/configuration.md` (`MAIL_TRANSPORT`, `SMTP_*`, `MAIL_FROM`,
`KEYCLOAK_REALM_SMTP`, `KEYCLOAK_HEALTH_URL`, `AI_ENABLED`, the `*_IMAGE` pins).

---

## What is not covered

- **Backups leaving the host.** Nightly backups and point-in-time recovery data
  land in the local MinIO; copying them off an air-gapped host is a
  transfer-gateway question for your network.
- **Signed images and SBOMs.** The bundle is verified by checksum; image
  signatures and software bills of materials are not produced yet.
- **A second host.** This guide runs the whole platform on one machine.
