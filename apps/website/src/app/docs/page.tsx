import type { Metadata } from "next";
import Link from "next/link";
import {
  Server,
  Code,
  Terminal,
  Database,
  Shield,
  Cloud,
  Link2,
  Rocket,
  Sparkles,
  Workflow,
  GitBranch,
  ArchiveRestore,
  Plug,
  Radio,
  KeyRound,
  HardDrive,
} from "lucide-react";
import { docsMetadata } from "./docs-metadata";
import { getAppPortalUrl, getAppSignupUrl, getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Build on basefyio: every project gets its own database, auth, file storage and an instant REST API, used from the SDK, the CLI or plain HTTP.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs", "Documentation", pageDescription);
}

function appPortalHostLabel(): string {
  try {
    return new URL(getAppPortalUrl()).host;
  } catch {
    return "app.basefyio.com";
  }
}

const EXPLORE = [
  { href: "/docs/quickstart", icon: Rocket, title: "Quickstart", desc: "From sign-up to your first query in five minutes" },
  { href: "/docs/data-engine", icon: Database, title: "Data Engine", desc: "Schema-driven document storage with nested queries" },
  { href: "/docs/connect", icon: Link2, title: "Connect", desc: "Use pgAdmin, DBeaver, DataGrip, psql or any ORM" },
  { href: "/docs/realtime", icon: Radio, title: "Realtime", desc: "Live insert, update and delete events" },
  { href: "/docs/auth", icon: KeyRound, title: "Authentication", desc: "Sign-up, sign-in, magic links, OAuth and MFA for your users" },
  { href: "/docs/storage", icon: HardDrive, title: "Storage", desc: "Buckets, uploads, signed and public URLs" },
  { href: "/docs/embeddings", icon: Sparkles, title: "AI & Embeddings", desc: "Vectors, semantic search and retrieval over your files" },
  { href: "/docs/flows", icon: Workflow, title: "Flows", desc: "Automations that run on the background job queue" },
  { href: "/docs/branches", icon: GitBranch, title: "Branches", desc: "Preview copies of a project's database" },
  { href: "/docs/backups", icon: ArchiveRestore, title: "Backups & PITR", desc: "Exports, nightly backups and point-in-time recovery" },
  { href: "/docs/integrations", icon: Plug, title: "Integrations", desc: "Connect GitHub and Vercel" },
  { href: "/docs/api", icon: Server, title: "API Reference", desc: "REST endpoints for data, auth, storage and projects" },
  { href: "/docs/sdk", icon: Code, title: "SDK Reference", desc: "JavaScript/TypeScript client with typed query builders" },
  { href: "/docs/cli", icon: Terminal, title: "CLI Reference", desc: "Projects, migrations and type generation from the terminal" },
  { href: "/docs/security", icon: Shield, title: "Security & RLS", desc: "Row-level security, API keys, JWT authentication" },
  { href: "/docs/self-hosting", icon: Cloud, title: "Self-Hosting", desc: "Run basefyio on your own servers with Docker Compose" },
];

export default function DocsOverview() {
  const apiUrl = getPublicApiUrl();
  const signupUrl = getAppSignupUrl();
  const appHost = appPortalHostLabel();

  return (
    <div>
      <h1>Documentation</h1>
      <p>
        basefyio is a backend you use from the cloud: sign up at{" "}
        <a href={signupUrl}>{appHost}</a>, create a project, and it comes with its own{" "}
        <strong>dedicated database</strong> &mdash; relational tables with full SQL &mdash; plus an{" "}
        <strong>optional document store</strong>, <strong>authentication</strong> for your app&apos;s
        users, <strong>file storage</strong> and an <strong>auto-generated REST API</strong>. Build
        against it with the SDK, the CLI, plain HTTP or any SQL client, and manage it from the
        dashboard.
      </p>
      <p>
        basefyio is also open source. If you would rather run the whole platform on your own
        servers, the <Link href="/docs/self-hosting">Self-Hosting guide</Link> covers it; everything
        else in these docs applies to both.
      </p>

      {/* ── Quick Start ──────────────────────────────────── */}

      <h2>Quick start</h2>
      <p>
        Create a free account at <a href={signupUrl}>{appHost}</a>, create a project, and copy its
        project ID and anon key from the project&apos;s <strong>Connection</strong> page. The{" "}
        <Link href="/docs/quickstart">Quickstart</Link> walks through every step.
      </p>

      <h3>1. Install the SDK</h3>
      <pre><code>{`npm install basefyio-js`}</code></pre>

      <h3>2. Initialize the client</h3>
      <pre><code>{`import { createClient } from 'basefyio-js'

const bf = createClient({
  apiUrl: '${apiUrl}',
  projectId: 'your-project-id',
  apiKey: 'your-anon-key',
})`}</code></pre>

      <h3>3. Start building</h3>
      <pre><code>{`// Query relational data
const { data: posts } = await bf.from('posts').select().eq('published', true)

// Insert a document (Data Engine)
const { data: patient } = await bf.data.collection('patients').insert({
  firstName: 'John',
  address: { city: 'Istanbul', country: 'TR' },
})

// Sign up a user
const { data: user } = await bf.auth.signUp({
  email: 'user@example.com',
  password: 'a-strong-password',
})

// Upload a file and get a temporary link to it
await bf.storage.from('avatars').upload('user-123.jpg', file)
const { data: url } = await bf.storage.from('avatars').createSignedUrl('user-123.jpg', { expiresIn: 3600 })`}</code></pre>

      {/* ── Explore ──────────────────────────────────────── */}

      <h2>Explore</h2>
      <div className="not-prose mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {EXPLORE.map(({ href, icon: Icon, title, desc }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-muted-foreground/30"
          >
            <Icon className="mb-3 h-5 w-5 text-primary" />
            <div className="font-semibold text-foreground transition-colors group-hover:text-primary">{title}</div>
            <div className="mt-1 text-sm text-muted-foreground">{desc}</div>
          </Link>
        ))}
      </div>

      {/* ── Platform Overview ────────────────────────────── */}

      <h2>What a project includes</h2>
      <p>
        Every project is a complete backend, isolated from every other project. When you create
        one, you get:
      </p>

      <div className="docs-table"><table>
        <thead>
          <tr>
            <th>Component</th>
            <th>What it is</th>
            <th>What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><strong>Database</strong></td><td>A dedicated PostgreSQL database</td><td>Relational data with full SQL, row-level security, foreign keys, triggers and pgvector</td></tr>
          <tr><td><strong>Data Engine</strong></td><td>Document store</td><td>Schema-driven documents for application records, nested data and flexible schemas</td></tr>
          <tr><td><strong>Authentication</strong></td><td>A per-project auth realm</td><td>Email/password, magic links, OAuth (Google, GitHub), MFA, JWT access and refresh tokens</td></tr>
          <tr><td><strong>Storage</strong></td><td>S3-compatible object storage</td><td>Uploads, downloads, signed URLs, public and private buckets</td></tr>
          <tr><td><strong>REST API</strong></td><td>Generated from your schema</td><td>CRUD on every table, filtering, ordering, pagination and RPC for your functions</td></tr>
          <tr><td><strong>Realtime</strong></td><td>Server-Sent Events</td><td>Live change events for the tables and collections you enable</td></tr>
          <tr><td><strong>AI &amp; Embeddings</strong></td><td>pgvector in your database</td><td>Store vectors, semantic search, retrieval over files in your buckets</td></tr>
          <tr><td><strong>Connection pooler</strong></td><td>PgBouncer</td><td>The endpoint your SQL tools and ORMs connect to</td></tr>
          <tr><td><strong>Dashboard</strong></td><td>{appHost}</td><td>SQL editor, table editor, data browser, storage browser, auth settings, backups</td></tr>
        </tbody>
      </table></div>

      {/* ── Core Concepts ────────────────────────────────── */}

      <h2>Core concepts</h2>

      <h3>Projects &amp; teams</h3>
      <p>
        Projects are the unit of isolation. Each project belongs to a <strong>team</strong>, and
        team members have role-based access: <code>OWNER</code>, <code>ADMIN</code> or{" "}
        <code>MEMBER</code>. Each role has permissions for project management, member management,
        billing and integrations. A personal team is created automatically for every user.
      </p>

      <h3>Two data planes</h3>
      <p>basefyio gives you two ways to store data, both reachable from the same SDK:</p>
      <ul>
        <li><strong>Relational tables</strong> — full SQL. Use <code>bf.from(&apos;table&apos;)</code> for structured data with relations, constraints, RLS policies and joins. Best for users, orders, products — anything with a strong schema and relationships.</li>
        <li><strong>Data Engine documents</strong> — schema-driven documents. Use <code>bf.data.collection(&apos;entity&apos;)</code> for nested objects, arrays, versioning and soft delete. Best for CMS content, form submissions, AI-generated data, mobile app records and events.</li>
      </ul>
      <p>
        See the <Link href="/docs/data-engine">Data Engine guide</Link> for details.
      </p>

      <h3>API keys</h3>
      <p>Every project has two API keys:</p>
      <ul>
        <li><strong>Anon key</strong> — safe for client-side code. Reaches the public endpoints and respects row-level security policies. Send it in the <code>apikey</code> header.</li>
        <li><strong>Service key</strong> — secret, full access, bypasses RLS. Use it only on your own server; never ship it to a browser or commit it to a repository.</li>
      </ul>
      <p>
        Scripts and AI agents that manage your account and projects use an account{" "}
        <strong>API token</strong> instead (<strong>Account → API Tokens</strong> in the dashboard).
      </p>

      <h3>Authentication</h3>
      <p>
        Each project has its own auth realm with independent users, sessions and OAuth providers:
        email and password with verification codes, magic links, Google and GitHub sign-in,
        authenticator-app MFA and anonymous sessions. Access tokens are short-lived; the SDK
        refreshes them automatically. Configure providers, token lifetimes, email templates and
        password policies under the project&apos;s <strong>Auth</strong> tab. See{" "}
        <Link href="/docs/auth">Authentication</Link>.
      </p>

      <h3>Storage</h3>
      <p>
        S3-compatible file storage with any number of buckets per project. Private buckets serve
        files through time-limited signed URLs or your keys; public buckets serve them at permanent
        URLs. Paths with <code>/</code> form folders. Upload limits and resumable uploads are
        described in the <Link href="/docs/storage">Storage guide</Link>.
      </p>

      <h3>Row-level security (RLS)</h3>
      <p>
        Every project database comes with the roles <code>anon</code>, <code>authenticated</code>{" "}
        and <code>service_role</code>. Write RLS policies to decide which rows each role can see,
        insert, update or delete; the API switches to the right role for every request based on
        the key and the user&apos;s token. See <Link href="/docs/security">Security &amp; RLS</Link>.
      </p>

      <h3>SQL editor</h3>
      <p>
        Run SQL against your project database from the dashboard, with syntax highlighting, query
        history, execution times, result export and an audit log of every query.
      </p>

      <h3 id="schema-migrations">Schema migrations</h3>
      <p>
        Project keys are data credentials. The <code>anon</code>, <code>authenticated</code> and
        <code> service_role</code> database roles hold table and function privileges only, so no key
        — the secret service key included — can run DDL. A migration runner that sends
        <code> CREATE TABLE</code> or <code>CREATE VIEW</code> through the API with the service key
        gets <code>permission denied for schema public</code>.
      </p>
      <p>
        Run migrations as the database owner instead, over a direct database connection. The
        project&apos;s Connection panel in the dashboard gives you the owner URI through the connection
        pooler — point your migration tool (Prisma, Drizzle, Flyway, psql, your own runner) at it. The
        pooler presents a self-signed certificate, so use <code>sslmode=require</code>. Team members
        can also apply schema changes from the dashboard SQL Editor or Table Editor, which run as the
        owner. See <Link href="/docs/connect">Connect</Link>.
      </p>

      <h3>Table editor</h3>
      <p>
        A spreadsheet-style editor for your tables: create tables, add, edit and delete columns,
        insert rows, edit cells inline, manage foreign keys, sort, filter, paginate and remove
        duplicates — without writing SQL.
      </p>

      <h3>Realtime</h3>
      <p>
        Subscribe to insert, update and delete events on the tables and collections you switch on,
        over Server-Sent Events. See <Link href="/docs/realtime">Realtime</Link>.
      </p>

      <h3>Automation, AI and operations</h3>
      <ul>
        <li><Link href="/docs/embeddings">AI &amp; Embeddings</Link> — store text as vectors in your own database, search it semantically, and index files from your buckets for retrieval.</li>
        <li><Link href="/docs/flows">Flows</Link> — named automations whose steps run on the background job queue, with a recorded history of every run.</li>
        <li><Link href="/docs/branches">Branches</Link> — preview copies of a project&apos;s database, schema only or with data.</li>
        <li><Link href="/docs/backups">Backups &amp; PITR</Link> — on-demand exports, nightly backups and point-in-time recovery.</li>
        <li><Link href="/docs/integrations">Integrations</Link> — link a GitHub repository and push your project&apos;s settings to Vercel.</li>
      </ul>

      <h3>Plans &amp; billing</h3>
      <p>
        Subscriptions are per team. Plans set the limits on projects, storage, database size, team
        members, API requests, bandwidth and monthly active users; usage is tracked continuously
        and shown under <strong>Billing</strong> in the dashboard. Current plans are on the{" "}
        <a href="/pricing">pricing page</a>.
      </p>

      {/* ── Architecture ─────────────────────────────────── */}

      <h2>How a request travels</h2>
      <p>
        Every route below lives under the API&apos;s <code>/api</code> prefix, at{" "}
        <code>{`${apiUrl}/api`}</code>.
      </p>
      <pre><code>{`┌──────────────────────────────────────────────┐
│   Client (browser / mobile / server)         │
│   SDK (basefyio-js), CLI or plain HTTP        │
└──────────────────┬───────────────────────────┘
                   │ HTTPS
┌──────────────────▼───────────────────────────┐
│   basefyio API                               │
│   ├── REST        /api/rest/v1/:table        │
│   ├── Auth        /api/rest/v1/auth/*        │
│   ├── Data Engine /api/v1/projects/:id/*     │
│   ├── Storage     /api/projects/:id/storage  │
│   ├── Realtime    /api/realtime/v1/stream    │
│   └── Projects    /api/projects, /api/teams  │
└───────┬──────────────┬──────────────┬────────┘
        │              │              │
  ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐
  │ project    │ │ document   │ │ auth realm │
  │ database   │ │ store      │ │            │
  └─────▲──────┘ └────────────┘ └────────────┘
        │
  ┌─────┴──────┐          ┌──────────────────┐
  │ connection │◄── SQL   │ object storage   │
  │ pooler     │   tools  │ (S3-compatible)  │
  └────────────┘          └──────────────────┘`}</code></pre>

      {/* ── Admin Dashboard ──────────────────────────────── */}

      <h2>The dashboard</h2>
      <p>
        The dashboard at <a href={signupUrl}>{appHost}</a> is where you manage everything. Each
        project has these sections:
      </p>
      <div className="docs-table"><table>
        <thead>
          <tr>
            <th>Section</th>
            <th>What you can do</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><strong>Overview</strong></td><td>Project info, API keys, usage</td></tr>
          <tr><td><strong>Table Editor</strong></td><td>Create tables, manage columns, edit rows inline, foreign keys, deduplication</td></tr>
          <tr><td><strong>Collections</strong></td><td>Document collections with JSON filters and indexes</td></tr>
          <tr><td><strong>Data</strong></td><td>Data Engine browser: entities, documents, schema versions</td></tr>
          <tr><td><strong>SQL Editor</strong></td><td>Run SQL, view results, query history, audit trail</td></tr>
          <tr><td><strong>Storage</strong></td><td>Buckets, uploads and downloads, signed URLs, public toggle</td></tr>
          <tr><td><strong>Auth</strong></td><td>Users, OAuth providers, email settings, password policies</td></tr>
          <tr><td><strong>REST API</strong></td><td>API explorer with endpoint documentation and testing</td></tr>
          <tr><td><strong>Connection</strong></td><td>Database and pooler URIs, API endpoint, keys</td></tr>
          <tr><td><strong>Backup &amp; Export</strong></td><td>Exports, nightly backups, restore, point-in-time recovery</td></tr>
          <tr><td><strong>Integrations</strong></td><td>GitHub and Vercel connections</td></tr>
          <tr><td><strong>AI / Embeddings</strong></td><td>Enable vectors, choose the embedding provider, see where text goes</td></tr>
          <tr><td><strong>Settings</strong></td><td>Name, description, realtime, danger zone (delete and restore)</td></tr>
        </tbody>
      </table></div>

      {/* ── What's Next ──────────────────────────────────── */}

      <h2>What&apos;s next</h2>
      <ul>
        <li><Link href="/docs/quickstart">Quickstart</Link> — your first project, key and query</li>
        <li><Link href="/docs/api">API Reference</Link> — every REST endpoint</li>
        <li><Link href="/docs/sdk">SDK Reference</Link> — the JavaScript/TypeScript client</li>
        <li><Link href="/docs/cli">CLI Reference</Link> — project management from the terminal</li>
        <li><Link href="/docs/security">Security &amp; RLS</Link> — row-level security and access control</li>
        <li><Link href="/docs/self-hosting">Self-Hosting</Link> — run basefyio on your own servers</li>
      </ul>
    </div>
  );
}
