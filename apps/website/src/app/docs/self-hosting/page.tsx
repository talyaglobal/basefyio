import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/self-hosting", {
    title: "Self-Hosting Guide",
    description:
      "Run basefyio on your own server with Docker Compose: PostgreSQL, Keycloak, MinIO, Redis, PgBouncer, the Data Engine store and Traefik.",
  });
}

const REPO_DOCS = "https://github.com/talyaglobal/basefyio/blob/main/docs";

export default function SelfHostingDocs() {
  return (
    <div>
      <h1>Self-Hosting Guide</h1>
      <p>
        basefyio is built to be self-hosted. The repository ships two Compose files: <code>docker-compose.yml</code>{" "}
        builds the applications from source and publishes every port on <code>localhost</code> (development, a
        single machine), and <code>docker-compose.prod.yml</code> runs pre-built images behind Traefik with
        Let&apos;s Encrypt certificates (production). This page covers both. The complete, step-by-step version
        lives in the repository:{" "}
        <a href={`${REPO_DOCS}/guides/self-hosting.md`}>docs/guides/self-hosting.md</a> (Turkish:{" "}
        <a href={`${REPO_DOCS}/KURULUM.md`}>docs/KURULUM.md</a>).
      </p>

      <h2>What runs</h2>
      <table>
        <thead><tr><th>Service</th><th>Image</th><th>Purpose</th><th>Port (dev file)</th></tr></thead>
        <tbody>
          <tr><td><strong>postgres</strong></td><td><code>pgvector/pgvector:pg16</code> (dev) · <code>ghcr.io/&lt;owner&gt;/basefyio-postgres</code> (prod, adds PostGIS)</td><td>The platform database and every project database</td><td>5433</td></tr>
          <tr><td><strong>keycloak</strong></td><td><code>quay.io/keycloak/keycloak:24.0</code></td><td>Identity: the dashboard realm and one realm per project</td><td>8080</td></tr>
          <tr><td><strong>redis</strong></td><td><code>redis:7-alpine</code></td><td>Cache, one-time codes, background job queue</td><td>6379</td></tr>
          <tr><td><strong>minio</strong></td><td><code>minio/minio</code></td><td>S3-compatible object storage</td><td>9000 / 9001 (console)</td></tr>
          <tr><td><strong>pgbouncer</strong></td><td><code>edoburu/pgbouncer</code></td><td>Connection pooling; the host customers connect their SQL tools to</td><td>6432</td></tr>
          <tr><td><strong>mongodb</strong> (prod) · <strong>nosql</strong>/<strong>couchdb</strong> (dev)</td><td><code>mongo:7</code> · <code>couchbase/server:community-7.6.2</code> · <code>apache/couchdb:3</code></td><td>Document store behind the Data Engine; optional (<code>DATA_ENGINE_PROVIDER</code>)</td><td>8091 / 5984</td></tr>
          <tr><td><strong>traefik</strong> (prod)</td><td><code>traefik:v3.1</code></td><td>Reverse proxy, TLS termination, HTTP→HTTPS redirect</td><td>80 / 443</td></tr>
          <tr><td><strong>platform-api</strong></td><td>built from <code>apps/platform-api/Dockerfile</code> · <code>ghcr.io/&lt;owner&gt;/basefyio-api</code></td><td>The API (NestJS) at <code>/api</code>; applies its own schema on start</td><td>4000</td></tr>
          <tr><td><strong>admin-ui</strong></td><td>built from <code>apps/admin-ui/Dockerfile</code> · <code>ghcr.io/&lt;owner&gt;/basefyio-ui</code></td><td>The dashboard (Next.js)</td><td>3000</td></tr>
          <tr><td><strong>website</strong></td><td>built from <code>apps/website/Dockerfile</code> · <code>ghcr.io/&lt;owner&gt;/basefyio-website</code></td><td>This site</td><td>3002</td></tr>
        </tbody>
      </table>

      <h2>The installer</h2>
      <p>
        <code>scripts/install.sh</code> installs, reconfigures, upgrades and rolls back a self-hosted stack. It asks
        which release to run (the tags, newest first) and which components: Keycloak 24, 26 or an external server, a
        direct PostgreSQL role with <code>CREATEDB</code>/<code>CREATEROLE</code> beside PgBouncer, where PgBouncer
        listens (all interfaces, this host only, or not at all), whether the document store runs, whether AI features
        are on, and whether platform mail goes through the HTTP API or an SMTP server. Every question defaults to what
        an installation does today, so pressing Enter through them changes nothing.
      </p>
      <pre><code>{`git clone https://github.com/talyaglobal/basefyio.git basefyio && cd basefyio
scripts/install.sh            # interactive
scripts/install.sh --yes --answers answers.env   # unattended
./basefyio ps                 # docker compose for this installation
scripts/install.sh root you@example.com          # after signing up: the first administrator`}</code></pre>
      <p>
        Answers can also come from environment variables (<code>BASEFYIO_KEYCLOAK=26</code>,{" "}
        <code>BASEFYIO_AI=off</code>, <code>BASEFYIO_MAIL=smtp</code>, …); they are stored in the env file, so an
        upgrade asks nothing that was answered before. A new installation pins every component image to the versions
        the release was tested with, and the installer prints them — with whether the release changed the database —
        when it finishes. On a host without internet access it loads an image bundle and starts without a single
        registry call. The full guide:{" "}
        <a href={`${REPO_DOCS}/SELF_HOSTING_OFFLINE.md`}>docs/SELF_HOSTING_OFFLINE.md</a>.
      </p>

      <h2>Development: everything on one machine</h2>
      <pre><code>{`git clone https://github.com/talyaglobal/basefyio.git basefyio
cd basefyio
cp .env.example .env

# Generate a value for every secret in .env. DB_CRED_ENC_KEY is required: the API refuses
# to store a project's database credential it cannot encrypt, so project creation fails without it.
openssl rand -base64 32   # run once per secret and paste the value

docker compose up -d --build`}</code></pre>
      <p>
        <code>docker compose up -d --build</code> also starts the Couchbase <code>nosql</code> service, which is heavy.
        If you do not need the document store, start the services you need by name:
      </p>
      <pre><code>{`docker compose up -d --build postgres keycloak redis minio pgbouncer platform-api admin-ui`}</code></pre>
      <p>
        Open <code>http://localhost:3000/login</code> and sign in with <code>KEYCLOAK_ADMIN_USER</code> /{" "}
        <code>KEYCLOAK_ADMIN_PASSWORD</code> from your <code>.env</code> (defaults <code>admin</code> / <code>admin</code>).
        The dashboard signs in against the Keycloak master realm, so the Keycloak admin is the first platform
        account. The API answers at <code>http://localhost:4000/api/health</code>.
      </p>

      <h2>Production: Traefik, TLS and pre-built images</h2>

      <h3>1. DNS</h3>
      <p>Create A records for these names (replace <code>example.com</code> with your <code>DOMAIN</code>):</p>
      <table>
        <thead><tr><th>Name</th><th>Service</th></tr></thead>
        <tbody>
          <tr><td><code>example.com</code></td><td>Website</td></tr>
          <tr><td><code>app.example.com</code></td><td>Dashboard (also <code>admin.example.com</code> for the admin console)</td></tr>
          <tr><td><code>api.example.com</code></td><td>Platform API</td></tr>
          <tr><td><code>auth.example.com</code></td><td>Keycloak</td></tr>
          <tr><td><code>storage.example.com</code></td><td>MinIO S3 API (public file URLs)</td></tr>
          <tr><td><code>minio-console.example.com</code></td><td>MinIO console</td></tr>
          <tr><td><code>db.example.com</code></td><td>PgBouncer, port 6432 (customers&apos; SQL clients)</td></tr>
          <tr><td><code>traefik.example.com</code></td><td>Traefik dashboard (basic auth)</td></tr>
        </tbody>
      </table>
      <p>Ports 80 and 443 must reach the host; Traefik obtains certificates with the HTTP challenge.</p>

      <h3>2. Environment</h3>
      <p>
        There is no <code>.env.production</code> in the repository (the pattern is git-ignored). Create it from
        the template and add the production-only variables the compose file interpolates:
      </p>
      <pre><code>{`cp .env.example .env.production

# Added for production (docker-compose.prod.yml reads them):
DOMAIN=example.com
ACME_EMAIL=ops@example.com
TRAEFIK_DASHBOARD_AUTH='admin:$apr1$...'      # htpasswd line; quote it
GHCR_OWNER=talyaglobal                         # namespace of the images below
DATA_ENGINE_PROVIDER=mongodb                   # or disabled
NOSQL_USERNAME=basefyio
NOSQL_PASSWORD=<strong random>
NOSQL_CONNSTR=mongodb://basefyio:<password>@mongodb:27017/?replicaSet=rs0&authSource=admin
PGBOUNCER_ADMIN_PASSWORD=<strong random>
METRICS_TOKEN=<strong random>                  # optional: publishes /api/metrics

# From the template, now with real values: POSTGRES_PASSWORD, KEYCLOAK_ADMIN_PASSWORD,
# MINIO_ROOT_PASSWORD, DB_CRED_ENC_KEY, RESEND_* (mail), STRIPE_* (optional), OAuth client ids (optional)`}</code></pre>
      <p>
        Any value containing <code>&lt;</code>, <code>&gt;</code>, <code>&amp;</code>, <code>|</code> or spaces must
        be quoted, or a shell that sources the file stops reading at that line. MongoDB runs as a one-node
        replica set and needs a keyfile once: <code>bash scripts/init-mongo-keyfile.sh</code> writes{" "}
        <code>secrets/mongo-keyfile</code>.
      </p>

      <h3>3. Images</h3>
      <p>
        The production file uses <code>image:</code> and never builds. Either pull a release and tag it as the
        <code>:latest</code> the compose file expects, or build the same Dockerfiles yourself with those names:
      </p>
      <pre><code>{`# Option A — a signed release (see docs/guides/supply-chain.md to verify it)
for i in api ui website postgres; do
  docker pull ghcr.io/talyaglobal/basefyio-$i:v2.9.0
  docker tag  ghcr.io/talyaglobal/basefyio-$i:v2.9.0 ghcr.io/$GHCR_OWNER/basefyio-$i:latest
done

# Option B — build locally
docker build -t ghcr.io/$GHCR_OWNER/basefyio-postgres:latest docker/postgres
docker build -t ghcr.io/$GHCR_OWNER/basefyio-api:latest      -f apps/platform-api/Dockerfile .
docker build -t ghcr.io/$GHCR_OWNER/basefyio-ui:latest       apps/admin-ui
docker build -t ghcr.io/$GHCR_OWNER/basefyio-website:latest  --build-arg NEXT_PUBLIC_SITE_URL=https://example.com -f apps/website/Dockerfile .`}</code></pre>

      <h3>4. Start and verify</h3>
      <pre><code>{`docker compose -f docker-compose.prod.yml --env-file .env.production up -d

docker compose -f docker-compose.prod.yml --env-file .env.production ps
curl -s https://api.example.com/api/health      # {"status":"ok", ...}
open https://app.example.com/login`}</code></pre>
      <p>
        Always pass <code>-f docker-compose.prod.yml --env-file .env.production</code>. A bare{" "}
        <code>docker compose</code> picks the development file, with different networks and default passwords.
      </p>

      <h2>Updating</h2>
      <p>
        With the installer, <code>scripts/install.sh upgrade</code> backs up every database, moves to the release you
        pick, and goes back to the previous release by itself if the API does not come up;{" "}
        <code>scripts/install.sh rollback</code> and <code>scripts/install.sh restore &lt;backup&gt;</code> are the
        explicit ways back. By hand:
      </p>
      <pre><code>{`# new images (pull + retag, or rebuild as above), then:
docker compose -f docker-compose.prod.yml --env-file .env.production up -d`}</code></pre>
      <p>
        The API applies its schema on every start (<code>prisma db push</code>), so there is no separate
        migration step. Compose recreates only the containers whose image or configuration changed; avoid
        recreating Keycloak for an application update, because that signs every dashboard user out.
      </p>

      <h2>Backups</h2>
      <ul>
        <li><strong>Project export</strong> — Dashboard → project → Backup &amp; Export, or <code>POST /api/projects/:id/export</code>, produces a ZIP with the database dump, realm users and storage objects.</li>
        <li><strong>Automatic daily backups</strong> — kept per project and restorable from the same page (<code>GET /api/projects/:id/backups</code>).</li>
        <li><strong>Point-in-time recovery</strong> — continuous WAL archiving with a seven-day window; see <a href={`${REPO_DOCS}/POINT_IN_TIME_RECOVERY.md`}>POINT_IN_TIME_RECOVERY.md</a> and <code>scripts/enable-pitr.sh</code>.</li>
      </ul>

      <h2>Monitoring</h2>
      <ul>
        <li><code>GET /api/health</code> — always 200; read <code>status</code> (<code>ok</code> or <code>degraded</code>) and <code>checks.email</code>.</li>
        <li><code>GET /api/metrics</code> — Prometheus text, published only when <code>METRICS_TOKEN</code> is set and sent as a bearer token.</li>
        <li><code>GET /api/v1/projects/:id/data-engine/health</code> (anon key) — whether the document store is reachable.</li>
        <li><code>docker compose ps</code> — every stateful service has a health check; the API waits for them at start.</li>
      </ul>
      <p>Details: <a href={`${REPO_DOCS}/guides/health-and-metrics.md`}>docs/guides/health-and-metrics.md</a>.</p>

      <h2>Troubleshooting</h2>
      <h3>Creating a project fails</h3>
      <p>
        The API log says <code>DB_CRED_ENC_KEY is not set</code>. Set it (32 random bytes, base64 or 64 hex
        characters) in <code>.env</code> / <code>.env.production</code> and recreate the API container. Keep the
        key safe: project database passwords are encrypted with it and cannot be recovered without it.
      </p>
      <h3>Keycloak does not start</h3>
      <p>
        It needs a healthy Postgres and its own <code>keycloak</code> database, created by{" "}
        <code>scripts/init-db.sql</code> on the first start of an empty data volume. Read{" "}
        <code>docker compose logs keycloak --tail=50</code>.
      </p>
      <h3>The API stays down</h3>
      <p>
        In production it waits for Postgres, Keycloak, Redis and MongoDB to report healthy. MongoDB&apos;s
        health check initiates the replica set on first start; give it 30 seconds and check{" "}
        <code>docker compose logs mongodb --tail=50</code>.
      </p>
      <h3>No certificate</h3>
      <p>
        Traefik needs port 80 reachable and the DNS names resolving to this host. Check{" "}
        <code>docker compose logs traefik --tail=50</code>.
      </p>
    </div>
  );
}
