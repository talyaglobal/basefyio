# Self-hosting on an air-gapped network

basefyio runs entirely from containers, so a host with no internet access can
run it as long as the images reach it some other way. This guide covers that
path end to end: bundling the images on a connected machine, carrying them
over, loading them, serving HTTPS with your own certificate (a public CA cannot
issue one to a host it cannot reach), and starting the stack without a single
registry call.

"Air-gapped" here means: the target host can neither pull from Docker Hub,
GHCR or quay.io, nor reach any external API. Everything the platform needs at
runtime is inside the images; the features that talk to the outside world
(OAuth sign-in through Google or GitHub, outbound email, card payments, hosted
AI models) simply stay unconfigured.

---

## What you need

| Where | What |
|---|---|
| Connected machine | Docker Engine with Compose v2, a checkout of this repository at the release you intend to run, registry access |
| Offline host | Docker Engine with Compose v2, the **same** checkout (same commit), roughly 2x the bundle size in free disk, the ports you intend to publish |
| Both | The same `COMPOSE_PROJECT_NAME` (the scripts default to `basefyio`) — images built from this repository are named after it |

The self-host file is `docker-compose.yml`. It builds the API, dashboard and
website images from source and pulls PostgreSQL, Keycloak, Redis, MinIO and
PgBouncer from public registries; the bundle below carries all of them.

---

## 1. Bundle the images (connected machine)

```bash
git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
git checkout <tag or commit you will run offline>

# Default profile (HTTP on localhost ports), plus the TLS proxy profile if you
# will terminate HTTPS with your own certificate (see step 4):
./scripts/bundle-images.sh --profile tls -o /tmp/basefyio-images.tar.gz
```

The script builds the services declared with `build:`, resolves every image the
compose file references (`docker compose config --images`), pulls what is not
present, and writes three files:

- `basefyio-images.tar.gz` — every image, from `docker save`
- `basefyio-images.images.txt` — the manifest: one image name per line
- `basefyio-images.tar.gz.sha256` — checksum to verify the transfer

Expect several gigabytes. Pass `--no-pull` to fail instead of pulling, if you
want to be sure the bundle contains only what you already vetted locally.

To bundle a production-shaped stack instead, point the script at that file:
`./scripts/bundle-images.sh -f docker-compose.prod.yml --env-file .env.production`
resolves the GHCR names and the exact `IMAGE_TAG` that deployment runs.

## 2. Carry the files over

Copy the tarball, the manifest and the `.sha256` file together with the
repository checkout (same commit) to the offline host — USB medium, a one-way
transfer gateway, whatever your network policy allows. The checksum is computed
on the file's basename, so the files may land in any directory as long as they
stay next to each other.

## 3. Load the images (offline host)

```bash
cd basefyio
./scripts/load-images.sh /media/transfer/basefyio-images.tar.gz
```

The loader verifies the checksum, runs `docker load`, and then checks every
name in the manifest against the local image store. A truncated or partial
transfer fails here, with the missing names listed, rather than as a container
that cannot start later.

## 4. Configure

```bash
cp .env.example .env
```

Edit `.env` and change every password. Then, for an offline host, add:

```bash
# Hostnames the proxy will serve (app.<DOMAIN>, api.<DOMAIN>, auth.<DOMAIN>, storage.<DOMAIN>)
DOMAIN=basefyio.internal.example
# Your certificate (PEM, full chain) and private key; see "TLS" below
TLS_CERT_FILE=/etc/ssl/basefyio/fullchain.pem
TLS_KEY_FILE=/etc/ssl/basefyio/privkey.pem
# Public URLs the API and dashboard advertise
PUBLIC_API_URL=https://api.basefyio.internal.example
NEXT_PUBLIC_APP_URL=https://app.basefyio.internal.example
KEYCLOAK_PUBLIC_URL=https://auth.basefyio.internal.example
```

Point the hostnames at the host in your internal DNS (or `/etc/hosts` on each
client).

### TLS with your own certificate

Let's Encrypt cannot validate a host it cannot reach, so the self-host compose
file carries an opt-in reverse proxy that serves a certificate you supply:

- `TLS_CERT_FILE` — the certificate chain in PEM (leaf first, then
  intermediates); from your internal CA, or a public certificate you obtained
  elsewhere for the names above
- `TLS_KEY_FILE` — the matching private key, unencrypted PEM

The proxy mounts both read-only, serves them as the default certificate for
every hostname, and watches the files — replace them on renewal and the new
certificate is picked up without a restart. Routes are defined in
`docker/traefik/dynamic/routers.yml`; the certificate wiring is in
`docker/traefik/dynamic/tls.yml`. Clients must trust the CA that issued the
certificate; for an internal CA that means distributing its root to browsers
and to any machine running the CLI or SDK.

Keycloak must know it sits behind a TLS-terminating proxy. Create a compose
override next to the main file:

```yaml
# docker-compose.override.yml — applied automatically by docker compose
services:
  keycloak:
    environment:
      KC_PROXY_HEADERS: xforwarded
      KC_HOSTNAME: auth.basefyio.internal.example
```

(It is an override rather than a default because a development stack without a
proxy must not start trusting forwarded headers from arbitrary clients.)

### Keep the containers from reaching out

Nothing in the stack needs the network to start, but a few components attempt
optional outbound calls and will log a failure on an isolated host. Silence
them in `docker-compose.override.yml`:

```yaml
services:
  platform-api:
    environment:
      CHECKPOINT_DISABLE: "1"          # Prisma CLI update check at container start
  admin-ui:
    environment:
      NEXT_TELEMETRY_DISABLED: "1"
  website:
    environment:
      NEXT_TELEMETRY_DISABLED: "1"
  minio:
    environment:
      MINIO_UPDATE: "off"
```

Features that require an external service stay off by leaving their variables
empty: `GOOGLE_CLIENT_ID`/`GITHUB_CLIENT_ID` (social sign-in), `RESEND_API_KEY`
(outbound email — password resets and invitations are then unavailable; create
users from the dashboard instead), `STRIPE_SECRET_KEY` (billing),
`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (hosted models).

## 5. Start

```bash
COMPOSE_PROJECT_NAME=basefyio docker compose --profile tls up -d --pull never
```

`--pull never` makes any missing image a hard error instead of a registry call
that hangs on an isolated network; if it fails, step 3 was incomplete. Without
the proxy (plain HTTP on `127.0.0.1` ports, for a workstation or a lab) drop
`--profile tls`.

Verify:

```bash
curl -sk https://api.basefyio.internal.example/api/health
# {"status":"ok"|"degraded","checks":{"email":{...}},"instance":{"id":"...","role":"leader","imageTag":"..."}}
```

`status: degraded` with `email.state: not-configured` is expected offline — it
tells you mail is off, not that the API is unhealthy. Then sign in at
`https://app.<DOMAIN>/login`.

## 6. Update

Repeat step 1 at the new release on the connected machine, carry the new
bundle over, load it, check out the matching commit, and run
`docker compose --profile tls up -d --pull never` again. The API applies its own
schema changes when it starts; there is no separate migration step. Old images
can be removed afterwards with `docker image prune`.

---

## What is not covered

- **Backups leaving the host.** Nightly backups and point-in-time recovery
  data land in the local MinIO. Copying them off an air-gapped host is a
  transfer-gateway question for your network, not a platform feature.
- **Signed images.** The bundle is verified by checksum; signature
  verification of individual images is a separate release-pipeline concern.
- **A second host.** This guide runs the whole platform on one machine.
