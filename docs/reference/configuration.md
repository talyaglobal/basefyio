# Configuration reference

Every environment variable the platform API, the dashboard (`admin-ui`) and the website read,
with the default the code falls back to, whether each compose file hands it to the container,
and what changes when you set it. The inventory was taken from the code
(`process.env.*` and `ConfigService.get(...)` across `apps/platform-api/src`, the dotted keys
resolved through `apps/platform-api/src/config/configuration.ts`, plus `apps/admin-ui` and
`apps/website`), not from `.env.example`.

## Read this first: what reaches the container

Both compose files give `platform-api` an explicit `environment:` list and no `env_file:`.
A value in your `.env` (development) or `.env.production` (production) is used **only to fill
in the `${VAR}` placeholders of the compose file**. A variable that the compose file does not
list is never seen by the API, however it is spelled in `.env`. Today that includes, among
others, `STORAGE_DRIVER` and every `S3_*`, every `REALTIME_*`, `MFA_*`, `ANON_SIGNIN_*`,
`PROVISION_*`, the PgBouncer pool globals (`PGBOUNCER_MAX_CLIENT_CONN` and friends),
`CRON_LEADER_*`, `METRICS_TOKEN` and every `BACKUP_*` / `BRANCH_*` variable. The
**Compose** column below says, per variable, whether `.env` takes effect.

To pass more variables, add an override file. Two ways, pick one:

**Explicit list** (precise; recommended on an existing installation):

```yaml
# docker-compose.override.yml — merged automatically by `docker compose` in development
services:
  platform-api:
    environment:
      METRICS_TOKEN: ${METRICS_TOKEN:-}
      STORAGE_DRIVER: ${STORAGE_DRIVER:-minio}
      REALTIME_RLS_FILTER: ${REALTIME_RLS_FILTER:-jwt}
      # …one line per variable you set
```

**Whole file** (convenient on a fresh installation):

```yaml
# docker-compose.override.yml
services:
  platform-api:
    env_file: .env          # production: .env.production
```

Entries under `environment:` take precedence over `env_file:` in Docker Compose, so with the
whole-file variant every value the compose file sets itself (`DATABASE_URL`, `KEYCLOAK_URL`,
`POSTGRES_DB`, …) stays in force; only variables the compose file leaves out are added. Before
using it on an installation that already has projects, check `.env` for the two identifiers
whose `.env.example` value differs from the code default — `PLATFORM_KEYCLOAK_CLIENT_ID` and
`DOCKER_LABEL_PREFIX` (see their rows) — and delete those lines unless you mean to change them.

`docker compose` merges `docker-compose.override.yml` on its own when no `-f` is given. The
production command names its files explicitly, so add the override there too:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.prod.override.yml \
  --env-file .env.production up -d
```

When you run the API outside Docker (`npm run start:dev` in `apps/platform-api`), Nest's
`ConfigModule` reads `apps/platform-api/.env` and every variable in it applies directly.

### How to read the tables

| Compose value | Meaning |
|---|---|
| `yes` | the compose file passes `${VAR}` through: setting it in `.env` takes effect |
| `fixed` | the compose file sets a literal value; `.env` cannot change it without an override |
| `derived` | the compose file builds the value from other variables, e.g. `https://api.${DOMAIN}` |
| `no` | not passed; the code default applies unless you add an override |
| `compose` | read by Docker Compose itself (ports, image tags, replica count), never by the app |

Defaults are what the code uses when the variable is absent or empty. Booleans written as
`!== 'false'` in the code are on unless set to exactly `false`; those written as `=== 'true'`
are off unless set to exactly `true`.

## Core URLs and process

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `DOMAIN` | — | compose / compose | Base domain of a production install: `app.`, `api.`, `auth.`, `storage.`, `db.`, `minio-console.`, `traefik.` are derived from it. Also used by the dev file's `tls` profile. |
| `PORT` | `4000` | fixed `4000` / fixed `4000` | Port the API listens on inside the container. |
| `APP_URL` | `NEXT_PUBLIC_APP_URL`, else `http://localhost:3000` | derived / derived | Dashboard origin: links in mails, the sign-in return address, redirect URIs registered on the dashboard's Keycloak client. Dev builds it from `NEXT_PUBLIC_APP_URL`, so set that one in `.env`; prod uses `https://app.${DOMAIN}`. |
| `NEXT_PUBLIC_APP_URL` | — | compose / no | In the dev file, the input for `APP_URL`. The API reads it only as the fallback for an unset `APP_URL`. |
| `ADMIN_URL` | unset | no / derived | A second dashboard origin allowed as a sign-in return target (prod: `https://admin.${DOMAIN}`, the admin console host). |
| `PUBLIC_API_URL` | `http://localhost:4000` | yes / derived | Public origin of the API: mail links, the platform OAuth callback (`<PUBLIC_API_URL>/api/auth/oauth/callback`), connection details shown to customers. |
| `WEBSITE_URL` | `http://localhost:3002` | no / derived | Public website origin; the CLI's browser login sends the user to `<WEBSITE_URL>/cli-connect`. |
| `CORS_ORIGIN` | `http://localhost:3000,http://localhost:3002` | fixed `*` / fixed `*` | Static origin allowlist. The API accepts requests from every origin anyway (credentials are off, see [docs/README.md](../README.md)), so this changes nothing today. |
| `NODE_ENV` | unset (`development` in audit records) | no / fixed `production` | Environment label on audit records; standard Node meaning. |

## Platform PostgreSQL

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `DATABASE_URL` | — | derived / derived | **Required.** The platform database for Prisma and the Drizzle module; the API does not start without it. Both compose files build it themselves from `POSTGRES_USER`/`POSTGRES_PASSWORD` against the database `kolaybase` on `postgres:5432` (prod appends `connection_limit=${API_DB_CONNECTION_LIMIT:-20}&pool_timeout=30`), so a `DATABASE_URL` line in `.env` is ignored by compose. Also used by the data engine's `postgres` provider. |
| `POSTGRES_HOST` | `localhost` | fixed `postgres` / fixed `postgres` | Host the API uses for administrative connections (creating project databases and roles). |
| `POSTGRES_PORT` | `5432` | fixed `5432` / fixed `5432` | Port for those connections. In the dev file, `POSTGRES_PORT` in `.env` is the **host** port Postgres is published on (default `5433`), not this value. |
| `POSTGRES_USER` | `kolaybase` | yes / yes (required) | Superuser of the cluster; initialises the Postgres container and owns provisioning. |
| `POSTGRES_PASSWORD` | `kolaybase_secret` | yes / yes (required) | Its password. Always set your own. |
| `POSTGRES_DB` | `kolaybase` | fixed `kolaybase` / fixed `kolaybase` | Name of the platform database. `kolaybase` is an internal identifier both compose files hard-code; keep it. |
| `POSTGRES_PUBLIC_HOST` | unset → the pooler's external host | yes (`localhost`) / no | Host printed in a project's **direct** (non-pooled) connection string. |
| `POSTGRES_PUBLIC_PORT` | unset → the pooler's external port | yes (`5433`) / no | Port printed in that string. |

## Keycloak (identity)

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `KEYCLOAK_URL` | `http://localhost:8080` | fixed `http://keycloak:8080` / fixed | Address the API uses to reach Keycloak. |
| `KEYCLOAK_PUBLIC_URL` | `KEYCLOAK_URL` | yes (`http://localhost:8080`) / derived `https://auth.${DOMAIN}` | Address browsers use for sign-in redirects, and the expected issuer of end-user tokens (`<value>/realms/<realm>`). It must equal the URL Keycloak is reached at publicly, because Keycloak stamps `iss` from it; a mismatch makes every signed-in request fail with 401. |
| `KEYCLOAK_ADMIN_USER` | `admin` | yes / yes (required) | Master-realm administrator the API uses to create a realm per project. Also the first dashboard login of a fresh install. |
| `KEYCLOAK_ADMIN_PASSWORD` | `admin` | yes / yes (required) | Its password. |
| `KEYCLOAK_ADMIN_CLIENT_ID` | `admin-cli` | fixed / fixed | Client used for that admin login. |
| `KEYCLOAK_POST_LOGOUT_REDIRECT_URIS` | empty | no / no | Extra post-logout redirect URIs (comma- or space-separated) added to the dashboard's Keycloak client. |
| `PLATFORM_KEYCLOAK_CLIENT_ID` | `kolaybase-platform` | no / no | Client id of the dashboard's OAuth client in the master realm; the API creates or updates it at start-up. Change it only on a fresh install — a new value creates a second client. (`.env.example` shows `basefyio-platform`; compose does not pass it, so the code default is what runs.) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | yes / yes | Google sign-in for the **dashboard** (configured as an identity provider in the master realm). Project end-user providers are set per project, not here. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | empty | yes / yes | GitHub sign-in for the dashboard. |
| `GITHUB_TEAMS_CLIENT_ID` / `GITHUB_TEAMS_CLIENT_SECRET` | empty | yes / yes | OAuth app for the team-level GitHub integration (connecting repositories), separate from sign-in. |
| `VERCEL_CLIENT_ID` / `VERCEL_CLIENT_SECRET` | empty | yes / yes | OAuth app for the team-level Vercel integration; the integration is unavailable without it. |

## Object storage

MinIO is bundled; `STORAGE_DRIVER=s3` points the same client at another S3-compatible store.
Behaviour is described in [storage-api.md](./storage-api.md).

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `MINIO_ENDPOINT` | `localhost` | fixed `minio` / fixed `minio` | MinIO host as the API reaches it. |
| `MINIO_PORT` | `9000` | fixed / fixed | Its port. |
| `MINIO_USE_SSL` | off | fixed `false` / fixed `false` | TLS between API and MinIO. |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `kolaybase` / `kolaybase_secret` | compose / compose | Initialise the MinIO container; compose hands them to the API as `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`. The API also falls back to them directly. |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | the root user and password | derived / derived | Credentials the API uses. |
| `MINIO_PUBLIC_ENDPOINT` | `localhost` | yes / derived `storage.${DOMAIN}` | Host used in public object URLs and presigned URLs. |
| `MINIO_PUBLIC_PORT` | `MINIO_PORT`, else `9000` | yes / fixed `443` | Port in those URLs. |
| `MINIO_PUBLIC_SSL` | `false` | no / fixed `true` | `https` in those URLs. |
| `STORAGE_DRIVER` | `minio` | no / no | `minio` keeps the `MINIO_*` wiring; `s3` uses the `S3_*` settings below. |
| `STORAGE_BUCKET_PREFIX` | `bf-` | no / no | Prefix of every physical bucket name. Change only on a fresh install. |
| `S3_ENDPOINT` | empty | no / no | URL or `host[:port]` of the S3-compatible store (`STORAGE_DRIVER=s3`). |
| `S3_REGION` | `us-east-1` | no / no | Bucket region; `auto` for Cloudflare R2. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | empty | no / no | Credentials for that store. |
| `S3_USE_SSL` | on | no / no | `false` for a plain-HTTP endpoint. |
| `S3_PATH_STYLE` | on | no / no | `false` = virtual-host addressing (recommended for AWS). |
| `S3_PUBLIC_ENDPOINT` | empty | no / no | Host for public and presigned URLs when it differs from the endpoint (CDN, custom domain). |
| `S3_BUCKET_POLICIES` | on | no / no | `false` on stores without `PutBucketPolicy` (R2): making a bucket public is then refused with a clear message. |
| `STORAGE_MAX_UPLOAD_MB` | `500` | no / no | Ceiling of a single-request upload; the body is spooled to disk and streamed to the store. |
| `STORAGE_UPLOAD_TMP_DIR` | `<os tmp>/basefyio-uploads` | no / no | Disk spool for uploads in flight. |
| `STORAGE_MAX_CONCURRENT_UPLOADS` | `8` | no / no | Uploads streaming to the store at once per API process; beyond it the API answers 503. |
| `STORAGE_RESUMABLE_CHUNK_MB` | `8` | no / no | Default chunk size of a resumable upload (clamped to 5–64). |
| `STORAGE_MAX_RESUMABLE_MB` | `5120` | no / no | Ceiling of one resumable upload. |
| `STORAGE_RESUMABLE_TTL_HOURS` | `24` | no / no | Unfinished upload sessions are aborted after this. |
| `STORAGE_TRANSFORM_MAX_DIMENSION` | `4096` | no / no | Largest width or height the image renderer produces. |
| `STORAGE_TRANSFORM_MAX_SOURCE_MB` | `25` | no / no | Largest source image it transforms. |
| `STORAGE_TRANSFORM_MAX_PIXELS` | `50000000` | no / no | Images with more pixels are refused. |
| `STORAGE_TRANSFORM_MAX_CONCURRENT` | `4` | no / no | Transforms at once per process (503 with `Retry-After` beyond). |
| `STORAGE_TRANSFORM_CACHE_SECONDS` | `3600` | no / no | `Cache-Control: max-age` on rendered images. |

## Redis

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | fixed `redis://redis:6379` / fixed | Caches, rate-limit counters, realtime fan-out. |
| `REDIS_QUEUE_URL` | = `REDIS_URL` | `redis://redis-queue:6379` / same | Durable state: BullMQ job queues, the scheduled-job lease, usage counters. The compose files run it as a second instance with `maxmemory-policy noeviction` and an append-only log, because the cache instance's `allkeys-lru` may evict exactly these keys under memory pressure. Unset = everything on `REDIS_URL`, as before. |
| `TRUSTED_PROXY_HOPS` | `1` | `1` / `1` | Proxies between the client and the API (Traefik = 1; a load balancer in front of it = 2). Sets Express's `trust proxy`, which decides what `req.ip` means for rate limits, the sign-in audit and realtime connection keys. |
| `SQL_QUERY_EMBEDDING` | `on` | `on` / `on` | `off` stops queueing an embedding job for every executed SQL statement (semantic search over past queries keeps what it already indexed). |
| `IMPORT_STALE_AFTER_MS` | `1800000` | no / no | On boot, an import or export job still marked active after this long with no progress is failed as an orphan of a dead process; younger ones are left alone, since another replica may be running them. |
| `REALTIME_FANOUT` | `redis` | no / no | `off` keeps realtime events (the customer data stream and the dashboard's own stream) inside each API process; with Redis they reach the connections every replica holds. |
| `RELEASE_STAGE` | `beta` | `beta` / `beta` | Which stage the product is in. `beta` puts a small "beta" badge next to the mark in e-mails and invoices and reports `release.stage` on `GET /api/health`; `ga` removes it. Anything else counts as `beta`. The dashboard and the website read the same value as `NEXT_PUBLIC_RELEASE_STAGE`, **inlined at build time** — the deploy workflow passes it from `.env.production`, so the value must be there before the build, not only in the running container. |

## PgBouncer and per-project pooling

Customer connections go through PgBouncer; the API writes its `pgbouncer.ini` and
`userlist.txt` and reloads it.

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `PGBOUNCER_HOST` | `pgbouncer` | fixed / fixed | Pooler host as the API reaches it (admin console, `RELOAD`). |
| `PGBOUNCER_PORT` | `6432` | fixed `6432` / fixed `6432` | Its port. In both files `PGBOUNCER_PORT` in `.env` is also the host port the pooler is published on. |
| `PGBOUNCER_EXTERNAL_HOST` | `localhost` | yes / derived `db.${DOMAIN}` | Host printed in a project's pooled connection string. |
| `PGBOUNCER_EXTERNAL_PORT` | `6432` | derived from `PGBOUNCER_PORT` / fixed `6432` | Port printed in it. |
| `PGBOUNCER_CONFIG_DIR` | `/etc/pgbouncer` | fixed / fixed | Directory (a volume shared with the pooler) the API writes the configuration into. |
| `PGBOUNCER_ADMIN_PASSWORD` | random per process, with a warning | no / yes | Pooler admin credential. Set it so the value survives a restart; required before running more than one API replica. |
| `PGBOUNCER_MAX_CLIENT_CONN` | `1000` | no / no | `max_client_conn` in the generated ini. |
| `PGBOUNCER_DEFAULT_POOL_SIZE` | `20` | no / no | `default_pool_size`. |
| `PGBOUNCER_MIN_POOL_SIZE` | `5` | no / no | `min_pool_size` — server connections kept open per database even when idle. |
| `PGBOUNCER_RESERVE_POOL_SIZE` | `5` | no / no | `reserve_pool_size`. |
| `PGBOUNCER_DEFAULT_MAX_DB_CONNECTIONS` | unset (no per-database cap) | no / no | Per-database `pool_size` + `max_db_connections` applied when neither the project nor its plan sets one. |
| `PGBOUNCER_MAX_DB_CONNECTIONS_CEILING` | `100` | no / no | Highest value a project or plan may set. |
| `PGBOUNCER_DB_CLIENT_LIMITS` | off | no / no | Also write `max_db_client_connections` (10× the server cap). Needs PgBouncer 1.24+; the API checks the pooler's version first. |

With none of the per-database values set, the generated `pgbouncer.ini` is byte-identical to the
one earlier versions wrote. The ini is regenerated and reloaded when the API starts, so a changed
pool global takes effect on the next API restart.

## Project provisioning

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `PROVISION_DEFAULT_EXTENSIONS` | on | no / no | Install `pg_trgm`, `pgcrypto`, `unaccent`, `btree_gist`, `uuid-ossp` and `vector` (plus `pg_stat_statements` where the server preloads it) into new, non-imported project databases. `false` = owner role only. |
| `PROVISION_READONLY_ROLE` | on | no / no | Create the SELECT-only companion role `<dbUser>_readonly` for new projects. |

## Security bindings

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `DB_CRED_ENC_KEY` | unset | yes / yes | **Required to create projects.** Encrypts project database passwords (and second-factor secrets) at rest with AES-256-GCM: 32 random bytes as base64 or 64 hex characters (`openssl rand -base64 32`). Without it the API refuses to store a project credential. Losing it makes stored credentials unreadable; rotating it needs a re-encryption, not a swap. |
| `SERVICE_KEY_PROJECT_BINDING` | refuse | no / yes | A service key aimed at another project is refused (403). `log` records the call and lets it through instead. |
| `ANON_WRITE_BINDING` | refuse | no / yes | A bare anon key on a route that needs a signed-in user is refused. `log` records and allows it. |
| `METRICS_TOKEN` | unset | no / no | Bearer token that unlocks `GET /api/metrics`; without it the route answers 401. See [health-and-metrics.md](../guides/health-and-metrics.md). |

## End-user authentication

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `MFA_CHALLENGE_TTL_SECONDS` | `300` | no / no | How long a sign-in second-factor challenge stays valid. |
| `MFA_MAX_ATTEMPTS` | `5` | no / no | Wrong codes allowed per challenge before it is destroyed and the session behind it revoked. |
| `ANON_SIGNIN_PER_IP_HOURLY` | `30` | no / no | Anonymous accounts one client IP may create per project per hour; `0` disables the limit. |
| `ANON_SIGNIN_PER_PROJECT_DAILY` | `5000` | no / no | Anonymous accounts a project may create per day; `0` disables the limit. |

Anonymous sign-in itself is switched on per project in the dashboard, not here. See
[auth-api.md](./auth-api.md).

## Realtime

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `REALTIME_FANOUT` | `redis` | no / no | `redis` delivers events through Redis pub/sub to every API process; `off` keeps delivery process-local. |
| `REALTIME_RLS_FILTER` | `jwt` | no / no | Row-level security on the stream: `jwt` filters subscribers that sent a user token, `all` filters anon subscribers too, `off` disables filtering. |
| `REALTIME_RLS_META_TTL_MS` | `60000` | no / no | Cache lifetime of the per-table "RLS enabled + primary key" lookup. |
| `REALTIME_PRESENCE_TTL_SEC` | `90` | no / no | A presence member expires this long after its last heartbeat (heartbeats every 25 s). |
| `REALTIME_BROADCAST_MAX_BYTES` | `65536` | no / no | Largest broadcast payload. |
| `REALTIME_BROADCAST_RATE_PER_MIN` | `600` | no / no | Broadcasts per sender per minute (the service key is exempt). |
| `REALTIME_BROADCAST_PROJECT_RATE_PER_MIN` | `6000` | no / no | Broadcasts per project per minute. |
| `REALTIME_BROADCAST_REQUIRE_JWT` | `0` | no / no | `1` = only a signed-in user (or the service key) may broadcast. |
| `KB_REALTIME_DISABLE` | unset | no / no | `1` turns off the dashboard's own live updates (it then polls). Does not affect the project stream. |

Details: [REALTIME_API.md](../REALTIME_API.md).

## Mail

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `TSMART_SEND_API_KEY` | unset | no / yes | Mail provider key, read before `RESEND_API_KEY`. A key set here (or any key starting `ts_`) also selects `https://send.tsmart.ai` as the API base. |
| `RESEND_API_KEY` | unset | yes / yes | Mail provider key. Without any key no mail is sent (verification, password reset and magic-link mails are skipped with a warning) and `/api/health` reports mail as `not-configured`. |
| `RESEND_BASE_URL` | the provider's own (`https://api.resend.com`) | no / yes | API base of a provider that speaks the same HTTP contract; wins over the key-prefix rule. |
| `RESEND_FROM_EMAIL` | `basefyio <noreply@basefyio.com>` | yes / yes | Sender. The value contains `<` and `>`: quote it in any file a shell will `source`. |
| `RESEND_REPLY_TO` | `support@basefyio.com` | yes / yes | Reply-To header. |
| `FEEDBACK_NOTIFY_EMAILS` | `support@talyasmart.com` | no / no | Comma-separated recipients of new-feedback notifications. |
| `BILLING_SUMMARY_RECIPIENT` | `support@talyasmart.com` | no / no | Recipient of the scheduled billing summary mail. |

## Billing

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | empty | yes / yes | Stripe API key. Without it the Stripe client is not created ("billing features disabled" at start-up) and checkout, portal and payment calls fail; plans and usage still read from the database. |
| `STRIPE_WEBHOOK_SECRET` | empty | yes / yes | Verifies Stripe webhook signatures. |
| `SHEERID_API_KEY` / `SHEERID_PROGRAM_ID` | unset | no / no | Student-plan eligibility through SheerID; without both, eligibility falls back to an academic e-mail domain check. |

The dashboard's Stripe publishable key is a build argument of the UI image — see [Admin UI](#admin-ui).

## Data engine (document collections and entities)

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `DATA_ENGINE_PROVIDER` | `disabled` | yes / yes | Backend of the collections and data-engine APIs: `disabled`, `postgres` (uses `DATABASE_URL`), `nosql` (Couchbase), `couchdb` or `mongodb`. |
| `NOSQL_CONNSTR` | empty | yes (`couchbase://nosql`) / yes (`couchbase://nosql`) | Connection string of the document store. For the dev file's CouchDB profile: `http://couchdb:5984`. |
| `NOSQL_USERNAME` / `NOSQL_PASSWORD` | empty | yes / yes | Its credentials. The dev file also initialises its Couchbase and CouchDB containers with them; the prod file initialises MongoDB with them. |
| `DATA_ENGINE_CONTAINER` | `basefyio-apps` | yes / yes | Bucket / database that holds the documents. |
| `DATA_ENGINE_NAMESPACE` | `projects` | yes / yes | Scope inside it. |
| `DATA_ENGINE_MAX_DOC_KB` | `1024` | yes / yes | Largest document. |
| `DATA_ENGINE_MAX_NESTING_DEPTH` | `8` | yes / yes | Deepest nesting. |
| `DATA_ENGINE_MAX_ARRAY_ITEMS` | `1000` | yes / yes | Longest array. |

The dev file starts the Couchbase `nosql` and `nosql-init` containers by default even though
the provider defaults to `disabled`; start the stack with explicit service names to skip them.

## Embeddings and AI

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | unset | yes / yes | Platform OpenAI key: embeddings with the default `openai` provider, and the agent runner. With the default provider and no key, platform embedding features are disabled (logged at start-up); a project may still store its own key. |
| `EMBEDDING_ENABLED` | on | no / no | `false` disables all embedding and vector search without removing the module. |
| `EMBEDDING_PROVIDER` | `openai` | yes / yes | Provider for the platform vector store: `openai`, `ollama` or `cohere`. |
| `EMBEDDING_MODEL` | provider default (`text-embedding-3-small`, `nomic-embed-text`, `embed-v4.0`) | yes / yes | Model id at the provider. |
| `EMBEDDING_BASE_URL` | provider default | yes / yes | Custom endpoint (an OpenAI-compatible gateway, a remote Ollama). |
| `EMBEDDING_DIMENSIONS` | model default | yes / yes | Request-side output width for models that support it. Stores are `vector(1536)`: narrower vectors are zero-padded, wider models refused. |
| `EMBEDDING_MAX_DAILY_TOKENS` | `1000000` | no / no | Daily cap on platform embedding tokens. |
| `EMBEDDING_FALLBACK_PROVIDER` / `_MODEL` / `_BASE_URL` | unset (no failover) | yes / yes | Provider used when the primary rejects the key, hits its quota or is unreachable. |
| `EMBEDDING_FALLBACK_DIMENSIONS` | unset | no / no | Output width for the fallback provider. |
| `EMBEDDING_FAILOVER_COOLDOWN_SEC` | `60` | yes / yes | How long a failed primary is skipped. |
| `EMBEDDING_ALLOW_PRIVATE_BASE_URL` | off | yes / yes | Allow per-project endpoints on private or plain-HTTP hosts (a LAN Ollama). |
| `EMBEDDING_REEMBED_MAX_ROWS` | `200000` | yes / yes | Largest store a project may re-embed in place after a model change. |
| `PLATFORM_REGION` | unset → "not specified" | yes / yes | ISO country code of this server, shown to customers as the data and storage region in the AI disclosure. |
| `OLLAMA_BASE_URL` | unset (agent runner: `http://localhost:11434/v1`) | yes / yes | Ollama host; a trailing `/v1` is tolerated. |
| `OLLAMA_API_KEY` | unset | yes / yes | Bearer token for an Ollama behind an authenticating proxy. |
| `COHERE_API_KEY` | unset | yes / yes | Platform Cohere key. |
| `NEBIUS_API_BASE_URL` | unset | no / no | Base URL for agents configured with the `nebius-private` provider. |

See [embeddings-api.md](./embeddings-api.md).

## Audit forwarding

Off until a target is set. Records are forwarded by the API process that created them.

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `AUDIT_FORWARD_URL` | unset | yes / yes | HTTPS endpoint that receives batches of audit records. |
| `AUDIT_FORWARD_TOKEN` | unset | yes / yes | Bearer token sent to it. |
| `AUDIT_FORWARD_FORMAT` | `ndjson` | yes / yes | `ndjson` or `json`. |
| `AUDIT_FORWARD_ALLOW_HTTP` | off | no / no | `true` accepts a plain-`http` URL (a local collector). |
| `AUDIT_FORWARD_TIMEOUT_MS` | `5000` | no / no | Request timeout (500–60000). |
| `AUDIT_SYSLOG_HOST` | unset | yes / yes | Syslog receiver (RFC 5424). |
| `AUDIT_SYSLOG_PORT` | `514` | yes / yes | Its port. |
| `AUDIT_SYSLOG_PROTOCOL` | `udp` | yes / yes | `udp` or `tcp`. |
| `AUDIT_SYSLOG_FACILITY` | `13` (log audit) | no / no | Syslog facility 0–23. |
| `AUDIT_SYSLOG_APP_NAME` | `basefyio-api` | no / no | APP-NAME field. |
| `AUDIT_SYSLOG_MAX_BYTES` | `8192` | no / no | Largest message (480–65535). |
| `AUDIT_QUEUE_MAX` | `10000` | no / no | In-memory queue length before the oldest records are dropped. |
| `AUDIT_BATCH_SIZE` | `100` | no / no | Records per webhook batch. |
| `AUDIT_FLUSH_MS` | `2000` | no / no | Flush interval. |
| `AUDIT_RETRIES` | `3` | no / no | Retries per batch (0–10). |

## Deployment and scale

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `GHCR_OWNER` | — | — / compose | Registry owner in the production image names `ghcr.io/<owner>/basefyio-*`. |
| `IMAGE_TAG` | `latest` | — / compose + yes | Tag of the `basefyio-api`, `basefyio-ui` and `basefyio-website` images in the prod file; also passed to the API, which reports it in `/api/health` and `/api/metrics` (`unknown` when unset). |
| `API_REPLICAS` | `1` | — / compose | Number of `platform-api` containers. Raise it only with `PGBOUNCER_ADMIN_PASSWORD` set and memory to spare. |
| `API_DB_CONNECTION_LIMIT` | `20` | — / compose | Prisma pool per API replica (part of the derived `DATABASE_URL`); multiplies by the replica count. |
| `CRON_LEADER_ELECTION` | on | no / no | One replica runs the scheduled jobs, chosen through a Redis lease. `false` = every process runs them. |
| `CRON_LEADER_TTL_MS` | `30000` | no / no | Lease lifetime. |
| `CRON_LEADER_RENEW_MS` | `10000` | no / no | Renewal interval. |
| `CRON_LEADER_WHEN_REDIS_DOWN` | `run` | no / no | When Redis is unreachable for a whole lease: `run` the jobs anyway or `pause` them. |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | `./docker/traefik/certs/tls.crt` / `.key` | compose / — | Certificate (PEM, full chain) and key for the dev file's `tls` profile. See [SELF_HOSTING_OFFLINE.md](../SELF_HOSTING_OFFLINE.md). |
| `ACME_EMAIL` | — | — / compose | Let's Encrypt account address for the production proxy. |
| `TRAEFIK_DASHBOARD_AUTH` | — | — / compose | `user:hash` basic-auth line protecting the proxy dashboard at `traefik.${DOMAIN}`. |
| `NODE_OPTIONS` | Node default | — / fixed `--max-old-space-size=1536` | Heap limit of the API process. |

Published host ports in the dev file are also compose variables: `POSTGRES_PORT` (5433),
`KEYCLOAK_PORT` (8080), `REDIS_PORT` (6379), `MINIO_API_PORT` (9000), `MINIO_CONSOLE_PORT`
(9001), `PGBOUNCER_PORT` (6432), `PLATFORM_API_PORT` (4000), `ADMIN_UI_PORT` (3000),
`WEBSITE_PORT` (3002), `COUCHDB_PORT` (5984), `NOSQL_MGMT_PORT` (8091), `NOSQL_N1QL_PORT`
(8093), `NOSQL_KV_PORT` (11210) and `CB_BUCKET_RAM_MB` (256, the Couchbase bucket quota).

## Backups, point-in-time recovery and disk

Point-in-time recovery uses volumes only the production file defines; see
[POINT_IN_TIME_RECOVERY.md](../POINT_IN_TIME_RECOVERY.md).

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `PITR_POSTGRES_IMAGE` | `pgvector/pgvector:pg16` | no / derived `ghcr.io/${GHCR_OWNER}/basefyio-postgres:latest` | Image of the throwaway Postgres that replays WAL. It must match the running cluster, extensions included. |
| `PITR_SCRATCH_VOLUME` | `kolaybase_pitr_scratch` | no / no | Docker volume handed to that container (and to the schema-dump step of Supabase imports). Compose names the volume `<project>_pitr_scratch`; the default matches a checkout in a directory named `kolaybase`, so set it (through an override) when your compose project has another name. |
| `POSTGRES_WAL_ARCHIVE_DIR` | `/var/lib/postgresql/wal_archive` | no / no | Where Postgres archives finished WAL segments (the prod file mounts a volume there). |
| `DISK_PROBE_DATA_PATH` | `/` | no / no | Path whose filesystem carries Docker's data (root console → server disk). |
| `DISK_PROBE_SYSTEM_PATH` | `/host/system` | no / no | Bind-mounted empty host directory used to measure the system disk. |
| `DISK_WARN_PERCENT` / `DISK_CRITICAL_PERCENT` | `80` / `90` | no / no | Disk usage thresholds for the warning and critical states. |

**Added in this release** — off-site copies, restore verification and preview branches. Full
explanation in [BACKUP_OFFSITE_AND_VERIFICATION.md](../BACKUP_OFFSITE_AND_VERIFICATION.md). None of
these is passed by either compose file today; use an override.

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `BACKUP_ENC_KEY` | unset | no / no | 32 bytes (base64 or 64 hex). Encrypts off-site copies and, with `BACKUP_ENCRYPT_LOCAL`, the nightly archive. Keep a copy off the server. Separate from `DB_CRED_ENC_KEY` so each can rotate alone. |
| `BACKUP_ENCRYPT_LOCAL` | off | no / no | Also store the nightly archive encrypted (`.enc`) in the local object store. |
| `BACKUP_S3_ENDPOINT` | unset | no / no | S3-compatible endpoint for off-site copies. With `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY` it turns copies on; a partial set is reported as misconfigured. |
| `BACKUP_S3_BUCKET` | unset | no / no | Remote bucket. |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | unset | no / no | Its credentials. |
| `BACKUP_S3_REGION` | `us-east-1` | no / no | Signing region. |
| `BACKUP_S3_PATH_STYLE` | on | no / no | `false` for virtual-host addressing (AWS). |
| `BACKUP_S3_PREFIX` | `basefyio/` | no / no | Key prefix inside the bucket. |
| `BACKUP_S3_TIMEOUT_MS` | `600000` | no / no | Per-object upload timeout (WAL segments: at most 120 s). |
| `BACKUP_OFFSITE_ALLOW_PLAINTEXT` | off | no / no | Allow copies without `BACKUP_ENC_KEY`; otherwise copies stay off until a key exists. |
| `BACKUP_TABLE_COUNTS` | on | no / no | Record per-table row counts, taken from the dump's own snapshot, in each archive. |
| `BACKUP_COUNT_MAX_TABLES` | `300` | no / no | Tables counted per archive. |
| `BACKUP_COUNT_TIMEOUT_MS` | `20000` | no / no | Time allowed per table count. |
| `BACKUP_VERIFY_ENABLED` | on | no / no | Weekly restore drill (Sundays 05:00, server time); manual runs work regardless. |
| `BACKUP_VERIFY_PROJECTS_PER_RUN` | `1` | no / no | Projects drilled per weekly run. |
| `BACKUP_VERIFY_PROJECT_IDS` | unset | no / no | Comma-separated project ids to drill instead of the rotation. |
| `BACKUP_VERIFY_MAX_ARCHIVE_MB` | `1024` | no / no | Larger archives are skipped. |
| `BACKUP_VERIFY_TIMEOUT_MS` | `1800000` | no / no | Time allowed per drill. |
| `BRANCH_LIMIT_PER_PROJECT` | `3` | no / no | Live preview branches per project. |
| `BRANCH_MAX_DB_MB` | `2048` | no / no | Largest parent database a full-data branch may copy; larger ones need a schema-only branch. |

## Integrations

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` | empty | no / yes | QuickBooks Online OAuth app (operator accounting). |
| `QUICKBOOKS_REDIRECT_URI` | empty | no / yes | Its OAuth redirect URI, e.g. `<PUBLIC_API_URL>/api/admin/quickbooks/callback`. |
| `QUICKBOOKS_ENVIRONMENT` | `production` | no / yes (`production`) | `sandbox` or `production`. |
| `QB_ENCRYPTION_KEY` | unset | no / yes | At least 16 characters; encrypts the stored QuickBooks tokens. Without it the integration answers 503. Never derive it from another credential. |
| `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` | — | no / yes | Passed by the prod file, but no code reads it today. |
| `TSMART_INTEGRATION_TOKEN_SHA256` | unset (feed off, 404) | no / yes | sha256 (hex) of the bearer token of the tsmart project feed. See [integrations/tsmart.md](../integrations/tsmart.md). |
| `CODEFYIO_*` | — | no / no | The Codefyio IDE adapter; its variables are listed in [CODEFYIO_ADAPTER.md](../CODEFYIO_ADAPTER.md). Inert until a verifier is configured. |
| `GITHUB_INSIGHTS_REPO` | `talyaglobal/basefyio` | no / yes | Repository whose stars, forks and traffic the operator's analytics page reports. |
| `GITHUB_INSIGHTS_TOKEN` | unset | no / yes | GitHub token with repo scope for clones/views; stars and forks work without it. |
| `NPM_INSIGHTS_PACKAGES` | `basefyio-cli` | no / yes | Comma-separated npm packages to report downloads for. |

The operator's marketing tooling reads `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
(`claude-opus-5`), `FAL_KEY`, `FAL_IMAGE_MODEL` (`fal-ai/flux/dev`), `FAL_VIDEO_MODEL`
(`fal-ai/kling-video/v1/standard/text-to-video`), `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
`ELEVENLABS_MODEL` (`eleven_multilingual_v2`), `PUBBLER_API_URL`, `PUBBLER_API_KEY`,
`PUBBLER_DEFAULT_INTEGRATION_ID` and the Google Search Console / Analytics settings
`GOOGLE_MARKETING_SERVICE_ACCOUNT_JSON`, `GOOGLE_MARKETING_SA_JSON_B64`,
`GOOGLE_SEARCH_CONSOLE_SITE_URL`, `GOOGLE_SEARCH_CONSOLE_INSPECT_URL`,
`GOOGLE_ANALYTICS_PROPERTY_ID`, `GOOGLE_MARKETING_IMPERSONATE_EMAIL` (all passed by both compose
files; every one optional — the admin page reports which legs are unconfigured). None of them
affects customer projects.

## Dedicated provisioning

Placing a project on its own Postgres container instead of the shared cluster. Off by default.

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `DEDICATED_DB_ENABLED` | off | no / no | `true` allows new projects on a dedicated container. Turn it on only on a host with capacity for another database. |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | fixed / fixed | Docker socket the API drives (both files mount it). |
| `DOCKER_NETWORK` | `v0-kolaybase_default` | fixed `v0-kolaybase_default` / yes (`kolaybase_default`) | Network dedicated containers join. Compose names a project's network `<project>_default`; the dev file's literal is stale and only matters if you enable dedicated provisioning in development. |
| `DOCKER_PG_IMAGE` | `pgvector/pgvector:pg16` | no / no | Image of a dedicated Postgres. |
| `DOCKER_MINIO_IMAGE` | `minio/minio:latest` | no / no | Image of a dedicated MinIO. |
| `DOCKER_LABEL_PREFIX` | `com.kolaybase` | no / no | Reverse-DNS prefix of the labels on managed containers. Keep the default on an existing install so earlier resources stay recognised. (`.env.example` shows `com.basefyio`.) |
| `OPENBAO_URL` / `OPENBAO_VAULT_TOKEN` | unset | no / no | Where the infrastructure provisioning module fetches its cloud credentials. Without `OPENBAO_URL` that module runs against an in-memory mock. |
| `HETZNER_API_TOKEN` | `dev-placeholder-token` | no / no | Handed only to that mock; real cloud calls take their token from OpenBao. |

## Admin UI

Variables prefixed `NEXT_PUBLIC_` are compiled into the dashboard when the image is built;
setting them on a running container changes nothing. The others are read at request time by
the dashboard's server routes.

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `API_INTERNAL_URL` | `http://localhost:4000` | fixed `http://platform-api:4000` / fixed | Where the dashboard's server-side proxy (`/api/proxy/...`) and SSE relays reach the API. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | unset | build arg + yes / yes (runtime only) | Stripe publishable key for the billing page; without it the page cannot load Stripe's card form. Takes effect only as a build argument: the dev file passes it as one, the production image receives it from the build workflow. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | no / yes (runtime only) | Initial API origin shown on the embeddings page before the API reports its own. |
| `NEXT_PUBLIC_APP_URL` | `https://app.basefyio.com` | no / no | Canonical dashboard URL in page metadata, `robots.txt` and the sitemap. |
| `NEXT_PUBLIC_SITE_URL` | `https://basefyio.com` | no / no | Website URL in page metadata. |
| `NEXT_PUBLIC_DOCS_URL` | `https://basefyio.com` | no / no | Base of the dashboard's documentation links (`<value>/docs`). |
| `NEXT_PUBLIC_BASEFYIO_REALTIME_DISABLE` | unset | no / no | `1` turns off the dashboard's live updates in the browser. |
| `SEO_AUDIT_SITE_URL` | `https://basefyio.com` | no / no | Site the operator's SEO audit page checks. |

## Website

| Variable | Default | Compose (dev / prod) | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | build arg default `https://basefyio.com`; outside a production build `http://localhost:3002` | build arg + yes (`http://localhost:3002`) / no | Canonical URL for metadata, sitemap and Open Graph. |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | `G-99MKTVXWZV` (basefyio's own property) | build arg / no | Google Analytics tag. Set it to an empty value at build time to leave the tag out of your build. |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | unset | no / no | Search Console verification meta tag. |
| `NEXT_PUBLIC_APP_URL` | `https://app.basefyio.com` | no / no | Dashboard link target (sign-up, sign-in). |
| `NEXT_PUBLIC_API_BASE_URL`, then `NEXT_PUBLIC_API_URL` | `https://api.basefyio.com` | no / no | Public API origin shown on the site. |
| `NEXT_PUBLIC_BILLING_API_URL` | unset | fixed `http://platform-api:4000` (runtime) / no | First origin tried when the home page loads plans; the code also tries the app URL, `http://platform-api:4000` and `http://localhost:4000`. |
| `VERCEL_URL` | unset | no / no | Used for the site URL when deployed on Vercel and `NEXT_PUBLIC_SITE_URL` is unset. |

## Client libraries

The JavaScript SDK falls back to `BASEFYIO_API_URL`, `BASEFYIO_PROJECT_ID` and
`BASEFYIO_ANON_KEY` when `createClient()` is called without them — see
[js-sdk.md](./js-sdk.md). The CLI honours `BASEFYIO_NO_UPDATE_NOTIFIER=1` and
`BASEFYIO_NO_AUTO_UPDATE=1` — see [cli.md](./cli.md).

## Development and CI

| Variable | Default | Purpose |
|---|---|---|
| `DOCS_STRICT` | unset (off) | Test-only. With `DOCS_STRICT=1`, `apps/platform-api/src/docs/route-coverage.spec.ts` fails when a controller route is missing from the reference manual; without it the missing routes are only printed as a warning. A documented route that no longer exists fails the spec either way. |

Source: `apps/platform-api/src/config/configuration.ts`, `apps/platform-api/src/main.ts`,
`apps/platform-api/src/mail-provider-env.ts`, `common/crypto/field-crypto.ts`,
`common/guards/api-key.guard.ts`, `common/audit/audit-sink.config.ts`,
`common/realtime/realtime-events.service.ts`, `modules/cluster/cron-leader.service.ts`,
`modules/health/metrics.controller.ts`, `modules/pgbouncer/pgbouncer.service.ts`,
`modules/realtime-data/realtime-{broadcast,fanout,policy,presence}.service.ts`,
`modules/projects/project-mfa.service.ts`, `modules/projects/project-anonymous-auth.service.ts`,
`modules/projects/project-pitr.service.ts`, `modules/projects/backups/*.ts`,
`modules/projects/branches/project-branch.service.ts`, `modules/queue/export.processor.ts`,
`modules/data-engine/data-engine.service.ts`, `modules/provisioning/provisioning.module.ts`,
`modules/quickbooks/quickbooks.service.ts`, `modules/integrations/tsmart/tsmart-integration.guard.ts`,
`modules/agent/agent-runner.service.ts`, `modules/billing/billing.service.ts`,
`modules/email/email.service.ts`; `apps/admin-ui` (`app/api/**`, `app/layout.tsx`,
`lib/basefyio-realtime.ts`, `Dockerfile`); `apps/website/src/lib/site-url.ts`,
`apps/website/src/components/google-analytics.tsx`, `apps/website/Dockerfile`;
`docker-compose.yml`, `docker-compose.prod.yml`, `.env.example`.
