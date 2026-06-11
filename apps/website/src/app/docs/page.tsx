import type { Metadata } from "next";
import Link from "next/link";
import { Server, Code, Terminal, Database, Shield, Cloud, Layers, ScrollText, FolderOpen, Globe, Key, Users, CreditCard, Zap, FileJson, Lock } from "lucide-react";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getAppPortalUrl, getAppSignupUrl, getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio is a self-hosted backend-as-a-service platform. dedicated databases, NoSQL data engine, authentication, file storage, auto-generated REST API, real-time events, team management, and billing — for every project.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs", {
    title: "Documentation",
    description: pageDescription,
    openGraph: {
      title: "Documentation | basefyio Docs",
      description: pageDescription,
    },
  });
}

function appPortalHostLabel(): string {
  try {
    return new URL(getAppPortalUrl()).host;
  } catch {
    return "app.basefyio.com";
  }
}

export default function DocsOverview() {
  const apiUrl = getPublicApiUrl();
  const signupUrl = getAppSignupUrl();
  const appHost = appPortalHostLabel();

  return (
    <div>
      <h1>Documentation</h1>
      <p>
        basefyio is a <strong>self-hosted backend-as-a-service platform</strong> that gives every project
        its own dedicated database, NoSQL document data engine, authentication system, file storage,
        and auto-generated REST API. Deploy with Docker Compose, manage via the Admin Dashboard, and
        build applications with the SDK or CLI.
      </p>

      {/* ── Quick Start ──────────────────────────────────── */}

      <h2>Quick Start</h2>
      <p>
        Create a free account at{" "}
        <a href={signupUrl}>{appHost}</a>, create a project, and start building.
      </p>

      <h3>1. Install the SDK</h3>
      <pre><code>{`npm install basefyio-js`}</code></pre>

      <h3>2. Initialize the Client</h3>
      <pre><code>{`import { createClient } from 'basefyio-js'

const bf = createClient({
  apiUrl: '${apiUrl}',
  projectId: 'your-project-id',
  apiKey: 'your-anon-key',
})`}</code></pre>

      <h3>3. Start Building</h3>
      <pre><code>{`// Query relational data (database)
const { data: posts } = await bf.from('posts').select().eq('published', true)

// Insert a document (Data Engine)
const { data: patient } = await bf.data.collection('patients').insert({
  firstName: 'John',
  address: { city: 'Istanbul', country: 'TR' },
})

// Query documents with nested filters
const { data: results } = await bf.data.collection('patients')
  .find({ 'address.city': 'Istanbul' })
  .sort('_createdAt', 'desc')
  .limit(20)

// Sign up a user
const { data: user } = await bf.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword',
})

// Upload a file
await bf.storage.from('avatars').upload('user-123.jpg', file)

// Get a signed URL
const { data: url } = await bf.storage.from('avatars').createSignedUrl('user-123.jpg', 3600)`}</code></pre>

      {/* ── Explore ──────────────────────────────────────── */}

      <h2>Explore</h2>
      <div className="not-prose grid gap-4 sm:grid-cols-3 mt-6">
        {[
          { href: "/docs/data-engine", icon: Database, title: "Data Engine", desc: "NoSQL document storage with schema validation and nested queries" },
          { href: "/docs/api", icon: Server, title: "API Reference", desc: "REST endpoints for data, auth, storage, and the data engine" },
          { href: "/docs/sdk", icon: Code, title: "SDK Reference", desc: "JavaScript/TypeScript client with typed query builders" },
          { href: "/docs/cli", icon: Terminal, title: "CLI Reference", desc: "Project management, migrations, type generation" },
          { href: "/docs/security", icon: Shield, title: "Security & RLS", desc: "Row-level security, API keys, JWT authentication" },
          { href: "/docs/self-hosting", icon: Cloud, title: "Self-Hosting", desc: "Docker Compose deployment, configuration, and operations" },
        ].map(({ href, icon: Icon, title, desc }) => (
          <Link
            key={href}
            href={href}
            className="rounded-xl border border-border bg-card p-5 hover:border-muted-foreground/30 transition-colors group"
          >
            <Icon className="h-5 w-5 text-primary mb-3" />
            <div className="font-semibold text-foreground group-hover:text-primary transition-colors">{title}</div>
            <div className="text-sm text-muted-foreground mt-1">{desc}</div>
          </Link>
        ))}
      </div>

      {/* ── Platform Overview ────────────────────────────── */}

      <h2>Platform Overview</h2>
      <p>
        Every basefyio project is a complete backend, isolated from other projects.
        When you create a project, you get:
      </p>

      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th>Technology</th>
            <th>What It Does</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><strong>Database</strong></td><td>Database</td><td>Relational data with full SQL, RLS, pgvector, foreign keys, triggers</td></tr>
          <tr><td><strong>Data Engine</strong></td><td>NoSQL store + PG fallback</td><td>Schema-driven document storage for application records, nested data, flexible schemas</td></tr>
          <tr><td><strong>Authentication</strong></td><td>auth service 24</td><td>Email/password, magic links, OAuth (Google, GitHub), JWT tokens, per-project realms</td></tr>
          <tr><td><strong>Storage</strong></td><td>object storage (S3-compatible)</td><td>File upload, download, signed URLs, public/private buckets</td></tr>
          <tr><td><strong>REST API</strong></td><td>Auto-generated</td><td>Auto-generated CRUD endpoints, filtering, pagination, ordering</td></tr>
          <tr><td><strong>Real-time</strong></td><td>Server-Sent Events</td><td>Live updates for project activity, data changes</td></tr>
          <tr><td><strong>Admin Dashboard</strong></td><td>Next.js</td><td>Visual management: SQL editor, table editor, data browser, storage browser, auth config</td></tr>
          <tr><td><strong>Connection Pooling</strong></td><td>PgBouncer</td><td>Efficient database connection reuse for high concurrency</td></tr>
        </tbody>
      </table>

      {/* ── Core Concepts ────────────────────────────────── */}

      <h2>Core Concepts</h2>

      <h3>Projects & Teams</h3>
      <p>
        Projects are the fundamental unit of isolation. Each project belongs to a <strong>team</strong>, and
        team members have role-based access: <code>OWNER</code>, <code>ADMIN</code>, or <code>MEMBER</code>.
        Each role has granular permissions for project management, member management, billing, and integrations.
        A personal team is created automatically for every user.
      </p>

      <h3>Two Data Planes</h3>
      <p>
        basefyio gives you two ways to store data, both accessible from the same SDK:
      </p>
      <ul>
        <li><strong>database (relational)</strong> — Full SQL power. Use <code>bf.from(&apos;table&apos;)</code> for structured data with relations, constraints, RLS policies, and joins. Best for: users, orders, products, anything with strong schemas and relationships.</li>
        <li><strong>Data Engine (documents)</strong> — Schema-driven NoSQL. Use <code>bf.data.collection(&apos;entity&apos;)</code> for flexible documents with nested objects, arrays, versioning, and soft-delete. Best for: CMS content, form submissions, AI-generated data, mobile app records, IoT events.</li>
      </ul>
      <p>
        Both planes are available simultaneously. database handles system metadata and relational data;
        the Data Engine handles application records and document workloads.
        See the <Link href="/docs/data-engine">Data Engine guide</Link> for details.
      </p>

      <h3>API Keys</h3>
      <p>
        Every project has two API keys:
      </p>
      <ul>
        <li><strong>Anon key</strong> — Safe for client-side code. Provides access to public endpoints and respects Row-Level Security policies. Include it in the <code>apikey</code> header.</li>
        <li><strong>Service key</strong> — Private, full access. Bypasses RLS. Use only server-side, never expose in client code or public repositories.</li>
      </ul>

      <h3>Authentication</h3>
      <p>
        Each project has its own auth realm with independent users, sessions, and OAuth providers.
        Supported authentication methods:
      </p>
      <ul>
        <li><strong>Email/password</strong> — Sign up, sign in, email verification with OTP, password reset</li>
        <li><strong>Magic links</strong> — Passwordless email-based authentication</li>
        <li><strong>OAuth</strong> — Google and GitHub (configurable per project from the dashboard)</li>
        <li><strong>JWT tokens</strong> — Access tokens (short-lived) + refresh tokens (long-lived). The SDK handles refresh automatically.</li>
      </ul>
      <p>
        Configure providers, token lifetimes, email templates, and password policies from the
        project&apos;s <strong>Auth</strong> tab in the dashboard.
      </p>

      <h3>Storage</h3>
      <p>
        S3-compatible file storage powered by object storage. Each project can have multiple storage buckets:
      </p>
      <ul>
        <li><strong>Private buckets</strong> — Files accessible only via signed URLs (time-limited) or the service key</li>
        <li><strong>Public buckets</strong> — Files accessible via permanent public URLs</li>
        <li>Upload files up to 10 MB via the API, larger files via direct object storage access</li>
        <li>Organize files into folders within buckets</li>
      </ul>

      <h3>Row-Level Security (RLS)</h3>
      <p>
        Every project database comes with RLS roles pre-installed: <code>anon</code>, <code>authenticated</code>, and <code>service_role</code>.
        Write database RLS policies to control which rows each role can see, insert, update, or delete.
        The API automatically switches to the correct role based on the JWT token.
        See the <Link href="/docs/security">Security & RLS guide</Link>.
      </p>

      <h3>SQL Editor</h3>
      <p>
        Execute arbitrary SQL queries against your project database from the dashboard.
        Features: syntax highlighting, query history, execution time tracking, result export, and
        full audit logging of every query.
      </p>

      <h3>Table Editor</h3>
      <p>
        Visual spreadsheet-style editor for your database tables. Create tables, add/edit/delete columns,
        insert rows, inline-edit cells, manage foreign keys, sort, filter, paginate, and deduplicate — all
        without writing SQL.
      </p>

      <h3>Real-time Events</h3>
      <p>
        basefyio streams project activity events via Server-Sent Events (SSE). Subscribe to channels
        for real-time updates on data changes, schema modifications, auth events, and more.
        The Admin Dashboard uses real-time events to show live activity feeds and toast notifications.
      </p>

      <h3>Integrations</h3>
      <p>
        Connect your project to external services:
      </p>
      <ul>
        <li><strong>GitHub</strong> — Link a repository for schema versioning and CI/CD</li>
        <li><strong>Vercel</strong> — Auto-deploy frontend applications</li>
      </ul>

      <h3>Billing & Plans</h3>
      <p>
        Team-level subscriptions managed via Stripe. Plans define limits for: projects, storage,
        database size, team members, API requests, bandwidth, and monthly active users. Usage is
        tracked in real-time and visible from the dashboard.
      </p>

      {/* ── Architecture ─────────────────────────────────── */}

      <h2>Architecture</h2>
      <pre><code>{`┌──────────────────────────────────────────┐
│   Client (Browser / Mobile / Server)     │
│   SDK (basefyio-js) or direct REST       │
└──────────────┬───────────────────────────┘
               │ HTTPS
┌──────────────▼───────────────────────────┐
│   Platform API (NestJS)                  │
│   ├── REST API (/rest/v1)                │
│   ├── Data Engine (/v1/projects/:id/data)│
│   ├── Auth (/rest/v1/auth)               │
│   ├── Storage (/storage)                 │
│   ├── SQL (/sql/execute)                 │
│   └── Admin (/projects, /teams, ...)     │
└──────┬──────────┬──────────┬─────────────┘
       │          │          │
  ┌────▼────┐ ┌──▼───┐ ┌───▼────┐
  │database│ │NoSQL │ │auth service│
  │  16      │ │Store │ │  24    │
  └─────────┘ └──────┘ └────────┘
       │                    │
  ┌────▼────┐          ┌───▼────┐
  │PgBouncer│          │ object storage  │
  └─────────┘          └────────┘`}</code></pre>

      {/* ── Admin Dashboard ──────────────────────────────── */}

      <h2>Admin Dashboard</h2>
      <p>
        The Admin Dashboard at <a href={signupUrl}>{appHost}</a> is your visual management interface.
        Each project has these sections:
      </p>
      <table>
        <thead>
          <tr>
            <th>Tab</th>
            <th>What You Can Do</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><strong>Overview</strong></td><td>Project info, connection strings, API keys, usage stats</td></tr>
          <tr><td><strong>Table Editor</strong></td><td>Create tables, manage columns, edit rows inline, foreign keys, deduplication</td></tr>
          <tr><td><strong>Collections</strong></td><td>NoSQL-style collections with document CRUD, JSON filters, GIN indexes</td></tr>
          <tr><td><strong>Data</strong></td><td>Data Engine browser: entities, document CRUD, schema versioning, AI provenance</td></tr>
          <tr><td><strong>SQL Editor</strong></td><td>Execute SQL, view results, query history, audit trail</td></tr>
          <tr><td><strong>Storage</strong></td><td>Manage buckets, upload/download files, signed URLs, public toggle</td></tr>
          <tr><td><strong>Auth</strong></td><td>User management, OAuth provider config, email settings, password policies</td></tr>
          <tr><td><strong>REST API</strong></td><td>API explorer with endpoint documentation and testing</td></tr>
          <tr><td><strong>Connection</strong></td><td>Database URIs, pooler URIs, API endpoints, auth realm info</td></tr>
          <tr><td><strong>Backup & Export</strong></td><td>Full project export (database + auth + storage) as ZIP</td></tr>
          <tr><td><strong>Integrations</strong></td><td>GitHub and Vercel connections</td></tr>
          <tr><td><strong>AI / Embeddings</strong></td><td>pgvector embeddings, semantic search, schema indexing</td></tr>
          <tr><td><strong>Settings</strong></td><td>Project name, description, danger zone (delete/restore)</td></tr>
        </tbody>
      </table>

      {/* ── What's Next ──────────────────────────────────── */}

      <h2>What&apos;s Next</h2>
      <ul>
        <li><Link href="/docs/data-engine">Data Engine guide</Link> — Learn about the NoSQL document data plane</li>
        <li><Link href="/docs/api">API Reference</Link> — Complete REST API documentation</li>
        <li><Link href="/docs/sdk">SDK Reference</Link> — JavaScript/TypeScript client library</li>
        <li><Link href="/docs/cli">CLI Reference</Link> — Command-line project management</li>
        <li><Link href="/docs/security">Security & RLS</Link> — Row-level security and access control</li>
        <li><Link href="/docs/self-hosting">Self-Hosting</Link> — Deploy basefyio with Docker Compose</li>
      </ul>
    </div>
  );
}
