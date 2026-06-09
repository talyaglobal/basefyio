import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/security", {
    title: "Security & Row-Level Security",
    description: "basefyio security model: API keys, JWT authentication, Row-Level Security (RLS) policies, and best practices.",
  });
}

export default function SecurityDocs() {
  return (
    <div>
      <h1>Security & Row-Level Security</h1>
      <p>
        basefyio uses a layered security model: API keys authenticate requests, JWT tokens identify users,
        and PostgreSQL Row-Level Security (RLS) policies control data access at the database level.
      </p>

      <h2>Authentication Flow</h2>
      <pre><code>{`Client → API Key (apikey header) → Platform API
  │
  ├── Anonymous access (anon key, no JWT)
  │   └── PostgreSQL role: anon
  │
  └── Authenticated access (anon key + JWT Bearer)
      └── PostgreSQL role: authenticated
          └── RLS policies filter rows based on auth.uid()

Server → Service Key (apikey header)
  └── PostgreSQL role: service_role (bypasses RLS)`}</code></pre>

      <h2>API Keys</h2>
      <table>
        <thead><tr><th>Key</th><th>Use In</th><th>RLS</th><th>Access Level</th></tr></thead>
        <tbody>
          <tr><td><strong>Anon Key</strong></td><td>Client-side (browser, mobile)</td><td>Enforced</td><td>Only rows allowed by RLS policies</td></tr>
          <tr><td><strong>Service Key</strong></td><td>Server-side only</td><td>Bypassed</td><td>Full access to all data</td></tr>
        </tbody>
      </table>
      <p><strong>Never expose your service key in client-side code, public repositories, or browser DevTools.</strong></p>

      <h2>JWT Tokens</h2>
      <p>
        When a user signs in, basefyio issues a JWT containing their user ID, email, and roles.
        The JWT is verified against the project&apos;s Keycloak realm JWKS endpoint. Claims are
        exposed to RLS policies via helper functions.
      </p>
      <table>
        <thead><tr><th>Function</th><th>Returns</th><th>Example Usage</th></tr></thead>
        <tbody>
          <tr><td><code>auth.uid()</code></td><td>Current user ID (from JWT <code>sub</code>)</td><td><code>WHERE user_id = auth.uid()</code></td></tr>
          <tr><td><code>auth.jwt()</code></td><td>Full JWT claims as JSON</td><td><code>WHERE auth.jwt()-&gt;&gt;&apos;email&apos; = email</code></td></tr>
          <tr><td><code>auth.role()</code></td><td>Current role name</td><td><code>WHERE auth.role() = &apos;authenticated&apos;</code></td></tr>
          <tr><td><code>auth.email()</code></td><td>Current user email</td><td><code>WHERE owner_email = auth.email()</code></td></tr>
        </tbody>
      </table>

      <h2>Row-Level Security (RLS)</h2>
      <p>
        Every project database has RLS enabled with three pre-installed roles:
      </p>
      <ul>
        <li><code>anon</code> — Unauthenticated users (public access)</li>
        <li><code>authenticated</code> — Signed-in users (JWT verified)</li>
        <li><code>service_role</code> — Server-side admin (bypasses all RLS)</li>
      </ul>
      <p>
        The API automatically switches to the correct role based on the request&apos;s authentication context
        using <code>SET LOCAL ROLE</code> inside a transaction.
      </p>

      <h3>Writing RLS Policies</h3>
      <p>Use the SQL Editor in the dashboard to create policies:</p>

      <pre><code>{`-- Users can only read their own data
CREATE POLICY "Users read own data" ON profiles
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users can insert their own profile
CREATE POLICY "Users insert own profile" ON profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Users can update their own profile
CREATE POLICY "Users update own data" ON profiles
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Public data readable by everyone
CREATE POLICY "Public posts readable" ON posts
  FOR SELECT
  TO anon, authenticated
  USING (published = true);

-- Only authors can edit their posts
CREATE POLICY "Authors edit own posts" ON posts
  FOR UPDATE
  TO authenticated
  USING (author_id = auth.uid());`}</code></pre>

      <h3>Enable RLS on a Table</h3>
      <pre><code>{`-- Enable RLS (required before policies take effect)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Force RLS for table owner too (recommended)
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;`}</code></pre>

      <h2>Best Practices</h2>
      <ul>
        <li><strong>Always enable RLS</strong> on tables that store user data. Without RLS, the <code>anon</code> role can read everything.</li>
        <li><strong>Use the anon key for clients</strong>. The service key should only be used in server-side code (backend APIs, cron jobs, admin scripts).</li>
        <li><strong>Test policies thoroughly</strong>. Use the SQL Editor with different roles to verify access.</li>
        <li><strong>Avoid storing secrets</strong> in the database. Use environment variables for API keys, tokens, and passwords.</li>
        <li><strong>Rotate compromised keys</strong> from the project settings. Regenerate the anon or service key if you suspect a leak.</li>
        <li><strong>Use HTTPS</strong>. basefyio enforces HTTPS in production via Traefik with automatic Let&apos;s Encrypt certificates.</li>
      </ul>

      <h2>Data Engine Security</h2>
      <p>
        The Data Engine enforces tenant isolation differently from RLS:
      </p>
      <ul>
        <li>Every query has <code>_projectId</code> injected server-side as a mandatory filter</li>
        <li>This filter cannot be omitted or overridden by callers</li>
        <li>Documents from Project A are invisible to Project B, even in shared storage</li>
        <li>The Data Engine uses the same JWT/API key authentication as the REST API</li>
      </ul>

      <h2>Audit Logging</h2>
      <p>
        basefyio logs security-relevant events:
      </p>
      <ul>
        <li><strong>SQL Audit Log</strong> — Every SQL query executed, with user, duration, and result count</li>
        <li><strong>Project Activity Log</strong> — Table/column/row changes, auth config changes, imports, exports</li>
        <li><strong>Data Engine Outbox</strong> — Every document create/update/delete event</li>
        <li><strong>Root Audit Log</strong> — Platform-level actions (user management, team changes, billing)</li>
      </ul>
    </div>
  );
}
