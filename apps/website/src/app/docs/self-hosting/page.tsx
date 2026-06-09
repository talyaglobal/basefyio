import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/self-hosting", {
    title: "Self-Hosting Guide",
    description: "Deploy basefyio with Docker Compose: PostgreSQL, Keycloak, MinIO, NoSQL store, PgBouncer, and Traefik reverse proxy.",
  });
}

export default function SelfHostingDocs() {
  return (
    <div>
      <h1>Self-Hosting Guide</h1>
      <p>
        basefyio is designed to be self-hosted. Deploy the entire platform with a single
        <code>docker compose up -d</code> command. This guide covers production deployment
        with Traefik, Let&apos;s Encrypt SSL, and all infrastructure services.
      </p>

      <h2>Infrastructure Services</h2>
      <table>
        <thead><tr><th>Service</th><th>Image</th><th>Purpose</th><th>Default Port</th></tr></thead>
        <tbody>
          <tr><td><strong>PostgreSQL</strong></td><td><code>pgvector/pgvector:pg16</code></td><td>Primary database (with pgvector)</td><td>5432</td></tr>
          <tr><td><strong>Keycloak</strong></td><td><code>quay.io/keycloak/keycloak:24.0</code></td><td>Authentication (OAuth2/OIDC)</td><td>8080</td></tr>
          <tr><td><strong>Redis</strong></td><td><code>redis:7-alpine</code></td><td>Caching, queues (BullMQ)</td><td>6379</td></tr>
          <tr><td><strong>MinIO</strong></td><td><code>minio/minio:latest</code></td><td>S3-compatible file storage</td><td>9000/9001</td></tr>
          <tr><td><strong>PgBouncer</strong></td><td><code>edoburu/pgbouncer:latest</code></td><td>Connection pooling</td><td>6432</td></tr>
          <tr><td><strong>NoSQL Store</strong></td><td><code>couchbase/server:community</code></td><td>Document data engine</td><td>8091/8093/11210</td></tr>
          <tr><td><strong>Traefik</strong></td><td><code>traefik:v3.1</code></td><td>Reverse proxy, SSL termination</td><td>80/443</td></tr>
        </tbody>
      </table>

      <h2>Application Services</h2>
      <table>
        <thead><tr><th>Service</th><th>Image</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><strong>Platform API</strong></td><td><code>ghcr.io/&lt;owner&gt;/basefyio-api:latest</code></td><td>NestJS backend (port 4000)</td></tr>
          <tr><td><strong>Admin UI</strong></td><td><code>ghcr.io/&lt;owner&gt;/basefyio-ui:latest</code></td><td>Next.js dashboard (port 3000)</td></tr>
          <tr><td><strong>Website</strong></td><td><code>ghcr.io/&lt;owner&gt;/basefyio-website:latest</code></td><td>Marketing site + docs (port 3000)</td></tr>
        </tbody>
      </table>

      <h2>Quick Start (Production)</h2>

      <h3>1. Clone and Configure</h3>
      <pre><code>{`git clone https://github.com/your-org/basefyio.git
cd basefyio
cp .env.production.example .env.production
# Edit .env.production with your values`}</code></pre>

      <h3>2. Required Environment Variables</h3>
      <pre><code>{`# Domain
DOMAIN=basefyio.com
ACME_EMAIL=admin@basefyio.com

# PostgreSQL
POSTGRES_USER=basefyio
POSTGRES_PASSWORD=<strong-random-password>

# Keycloak
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=<strong-random-password>

# MinIO
MINIO_ROOT_USER=basefyio
MINIO_ROOT_PASSWORD=<strong-random-password>

# NoSQL Store (Data Engine)
DATA_ENGINE_PROVIDER=nosql
NOSQL_CONNSTR=couchbase://nosql
NOSQL_USERNAME=basefyio
NOSQL_PASSWORD=<strong-random-password>

# OAuth (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Email (optional)
RESEND_API_KEY=
RESEND_FROM_EMAIL=noreply@basefyio.com

# Stripe (optional)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=`}</code></pre>

      <h3>3. Deploy</h3>
      <pre><code>{`docker compose -f docker-compose.prod.yml --env-file .env.production up -d`}</code></pre>
      <p>
        This starts all services, initializes the NoSQL store (bucket, scope, collection, indexes),
        runs database migrations, and configures Traefik with automatic SSL certificates.
      </p>

      <h3>4. Verify</h3>
      <pre><code>{`# Check all services are healthy
docker compose -f docker-compose.prod.yml ps

# Check the API
curl https://api.basefyio.com/health

# Check the dashboard
open https://app.basefyio.com

# Check the NoSQL store
curl -u basefyio:<password> https://localhost:8091/pools`}</code></pre>

      <h2>DNS Configuration</h2>
      <p>Point these domains to your server&apos;s IP address:</p>
      <table>
        <thead><tr><th>Domain</th><th>Service</th><th>Record Type</th></tr></thead>
        <tbody>
          <tr><td><code>basefyio.com</code></td><td>Website</td><td>A</td></tr>
          <tr><td><code>app.basefyio.com</code></td><td>Admin Dashboard</td><td>A</td></tr>
          <tr><td><code>api.basefyio.com</code></td><td>Platform API</td><td>A</td></tr>
          <tr><td><code>auth.basefyio.com</code></td><td>Keycloak</td><td>A</td></tr>
          <tr><td><code>storage.basefyio.com</code></td><td>MinIO S3 API</td><td>A</td></tr>
          <tr><td><code>db.basefyio.com</code></td><td>PgBouncer (external)</td><td>A</td></tr>
        </tbody>
      </table>
      <p>Traefik handles SSL certificates automatically via Let&apos;s Encrypt HTTP challenge.</p>

      <h2>Development Setup</h2>
      <pre><code>{`# Uses docker-compose.yml (ports exposed on localhost)
docker compose up -d

# Or run individual services
docker compose up -d postgres keycloak redis minio nosql nosql-init

# Run API locally (outside Docker)
cd apps/platform-api
npm run start:dev

# Run Admin UI locally
cd apps/admin-ui
npm run dev`}</code></pre>
      <p>
        For development without the NoSQL store, set <code>DATA_ENGINE_PROVIDER=postgres</code> in
        your <code>.env</code> — the Data Engine will use PostgreSQL JSONB instead.
      </p>

      <h2>Backup & Restore</h2>
      <ul>
        <li><strong>PostgreSQL</strong> — Use <code>pg_dump</code> or the project export feature in the dashboard</li>
        <li><strong>MinIO</strong> — Use <code>mc mirror</code> (MinIO client) for bucket backup</li>
        <li><strong>Keycloak</strong> — Export realms via the Keycloak admin API or dashboard</li>
        <li><strong>NoSQL store</strong> — Use the store&apos;s built-in backup tool</li>
        <li><strong>Full project export</strong> — Dashboard &rarr; Backup & Export creates a ZIP with database, auth, and storage</li>
      </ul>

      <h2>Monitoring</h2>
      <ul>
        <li><strong>Docker health checks</strong> — All services have health checks; <code>docker compose ps</code> shows status</li>
        <li><strong>Platform API</strong> — <code>GET /health</code> returns platform status</li>
        <li><strong>Data Engine</strong> — <code>GET /v1/projects/:id/data-engine/health</code> returns NoSQL store reachability</li>
        <li><strong>Traefik dashboard</strong> — Available at <code>traefik.basefyio.com</code> (protected by basic auth)</li>
        <li><strong>MinIO console</strong> — Available at <code>minio-console.basefyio.com</code></li>
      </ul>

      <h2>Updating</h2>
      <pre><code>{`# Pull latest images
docker compose -f docker-compose.prod.yml --env-file .env.production pull

# Restart with updated images
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# Database migrations run automatically on API startup (prisma db push)`}</code></pre>

      <h2>Troubleshooting</h2>
      <h3>Keycloak won&apos;t start</h3>
      <p>
        Check PostgreSQL is healthy first. Keycloak depends on it for its database.
        View logs: <code>docker compose logs keycloak --tail=50</code>
      </p>

      <h3>Platform API depends on Keycloak</h3>
      <p>
        The API waits for Keycloak&apos;s health check. If Keycloak is stuck, the API won&apos;t start.
        Fix Keycloak first, then the API will auto-start.
      </p>

      <h3>NoSQL store not healthy</h3>
      <p>
        After cluster initialization, the health check requires authentication. The health check
        command tries both authenticated and unauthenticated requests. If the store was recently
        restarted, wait 30 seconds for warmup.
      </p>

      <h3>SSL certificate not issued</h3>
      <p>
        Traefik uses Let&apos;s Encrypt HTTP challenge. Ensure port 80 is open and DNS records
        point to your server. Check Traefik logs: <code>docker compose logs traefik --tail=50</code>
      </p>
    </div>
  );
}
