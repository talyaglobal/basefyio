import type { Metadata } from "next";
import Link from "next/link";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getAppPortalUrl } from "@/lib/site-url";

const pageDescription =
  "Connect to your basefyio project database from external tools like pgAdmin, DBeaver, DataGrip, TablePlus, or the terminal.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/connect", {
    title: "External Database Access",
    description: pageDescription,
    openGraph: {
      title: "External Database Access | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function ConnectDocs() {
  const appUrl = getAppPortalUrl();

  return (
    <div>
      <h1>External Database Access</h1>
      <p>
        Every basefyio project includes a dedicated database that you can access
        from any standard SQL client. Use pgAdmin, DBeaver, DataGrip, TablePlus,
        or a plain <code>psql</code> terminal — no vendor lock-in.
      </p>

      {/* ── Finding Your Credentials ──────────────────── */}

      <h2>Finding Your Connection Details</h2>
      <p>
        Open your project in the <a href={appUrl}>basefyio dashboard</a>, then
        go to <strong>Connection</strong> in the sidebar. You will see:
      </p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><strong>Host</strong></td><td>External database hostname (e.g. <code>db.basefyio.com</code>)</td></tr>
          <tr><td><strong>Port</strong></td><td>Connection pooler port (default <code>6432</code>)</td></tr>
          <tr><td><strong>Database</strong></td><td>Your project&apos;s database name</td></tr>
          <tr><td><strong>User</strong></td><td>Database username for your project</td></tr>
          <tr><td><strong>Password</strong></td><td>Database password (can be reset from the Connection page)</td></tr>
          <tr><td><strong>Connection URI</strong></td><td>Full connection string — copy and paste directly</td></tr>
        </tbody>
      </table>

      {/* ── pgAdmin ──────────────────────────────────── */}

      <h2>pgAdmin</h2>
      <ol>
        <li>Open pgAdmin and right-click <strong>Servers</strong> → <strong>Register</strong> → <strong>Server</strong></li>
        <li>In the <strong>General</strong> tab, give it a name (e.g. your project name)</li>
        <li>
          In the <strong>Connection</strong> tab, fill in:
          <ul>
            <li><strong>Host:</strong> your Host from the Connection page</li>
            <li><strong>Port:</strong> <code>6432</code></li>
            <li><strong>Maintenance database:</strong> your Database name</li>
            <li><strong>Username:</strong> your User</li>
            <li><strong>Password:</strong> your Password (check &quot;Save password&quot;)</li>
          </ul>
        </li>
        <li>Click <strong>Save</strong></li>
      </ol>

      {/* ── DBeaver ──────────────────────────────────── */}

      <h2>DBeaver</h2>
      <ol>
        <li>Click <strong>New Database Connection</strong> (or <kbd>Ctrl+Shift+N</kbd>)</li>
        <li>Select <strong>PostgreSQL</strong> and click <strong>Next</strong></li>
        <li>
          Fill in:
          <ul>
            <li><strong>Host:</strong> your Host</li>
            <li><strong>Port:</strong> <code>6432</code></li>
            <li><strong>Database:</strong> your Database name</li>
            <li><strong>Username:</strong> your User</li>
            <li><strong>Password:</strong> your Password</li>
          </ul>
        </li>
        <li>Click <strong>Test Connection</strong> to verify, then <strong>Finish</strong></li>
      </ol>

      {/* ── DataGrip / TablePlus ─────────────────────── */}

      <h2>DataGrip / TablePlus</h2>
      <p>
        Both tools support pasting a full connection URI. Copy the <strong>Pooler Connection URI</strong> from
        the Connection page and paste it into the &quot;URL&quot; or &quot;Import from URL&quot; field.
      </p>

      {/* ── Terminal (psql) ──────────────────────────── */}

      <h2>Terminal (psql)</h2>
      <p>
        Copy the connection URI from the dashboard and run:
      </p>
      <pre><code>{`psql "postgresql://USER:PASSWORD@db.basefyio.com:6432/YOUR_DATABASE"`}</code></pre>
      <p>
        Replace the URI with the actual <strong>Pooler Connection URI</strong> from your Connection page.
      </p>

      {/* ── Prisma / Drizzle / ORMs ──────────────────── */}

      <h2>Prisma, Drizzle, and ORMs</h2>
      <p>
        Use the connection strings from the <strong>Raw Editor</strong> tab on the Connection page.
        Two environment variables are provided:
      </p>
      <ul>
        <li><code>DATABASE_URL</code> — Connection pooler (for queries at runtime)</li>
        <li><code>DIRECT_URL</code> — Direct connection (for migrations and schema pushes)</li>
      </ul>
      <pre><code>{`# .env
DATABASE_URL=postgresql://USER:PASSWORD@db.basefyio.com:6432/YOUR_DATABASE
DIRECT_URL=postgresql://USER:PASSWORD@db.basefyio.com:6432/YOUR_DATABASE`}</code></pre>
      <p>
        In your Prisma schema:
      </p>
      <pre><code>{`datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}`}</code></pre>

      {/* ── Connection Pooling ───────────────────────── */}

      <h2>Connection Pooling</h2>
      <p>
        All external connections go through a connection pooler running in <strong>transaction mode</strong>.
        This means:
      </p>
      <ul>
        <li>Thousands of client connections are multiplexed onto a smaller set of database connections</li>
        <li>Each transaction gets a dedicated database connection for its duration</li>
        <li>Idle connections are returned to the pool automatically</li>
      </ul>
      <p>
        For most use cases (queries, ORMs, GUI tools), the pooler works transparently.
        If you need session-level features (e.g. <code>SET</code> statements, prepared statements
        across transactions), use the <strong>Direct Connection URI</strong> instead.
      </p>

      {/* ── Password Management ──────────────────────── */}

      <h2>Password Management</h2>
      <p>
        You can reset your database password from the <strong>Connection</strong> page in the dashboard.
        Generate a strong password or set your own. After resetting:
      </p>
      <ul>
        <li>Update the password in your <code>.env</code> file and any connected tools</li>
        <li>Active connections using the old password will be disconnected</li>
        <li>The new password takes effect immediately</li>
      </ul>

      {/* ── Security Notes ───────────────────────────── */}

      <h2>Security</h2>
      <ul>
        <li>Never commit database passwords to version control</li>
        <li>Use <code>.env</code> files (added to <code>.gitignore</code>) for local development</li>
        <li>Use your hosting platform&apos;s secret management for production deployments</li>
        <li>The connection is encrypted in transit via TLS</li>
      </ul>

      <hr />

      <p>
        For REST API access without a database client, see the{" "}
        <Link href="/docs/api">API Reference</Link>. For SDK integration, see the{" "}
        <Link href="/docs/sdk">SDK documentation</Link>.
      </p>
    </div>
  );
}
