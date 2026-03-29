'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionStrings } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Copy,
  Database,
  Key,
  Link2,
  Shield,
  Globe,
  Terminal,
  Code,
  Layers,
  Sparkles,
} from 'lucide-react';

interface ConnectionStringsViewProps {
  projectId: string;
}

/**
 * Single copy-paste block for ChatGPT, Claude, Cursor, etc. so the model can
 * wire up env vars, ORMs, or REST clients without guessing.
 */
function buildAiQuickConnectPrompt(
  conn: ConnectionStrings,
  projectId: string,
): string {
  return `TASK: Configure my application to connect to my Kolaybase-hosted project using ONLY the values below. Do not invent hostnames, ports, or keys.

=== CRITICAL FOR AI (read before writing any code) ===
1) SOURCE OF TRUTH: Every hostname below (REST_BASE_URL, pooler host, Keycloak URL, etc.) comes from the Kolaybase dashboard for THIS deployment. If the user's Kolaybase runs on a production server, these URLs are production URLs — they are NOT localhost.
2) NEVER substitute localhost:4000, localhost:5432, or any dev URL unless the quoted REST_BASE_URL itself already contains localhost. A common bug is generating client code that calls http://localhost:4000 while the real API is https://… — that causes "Failed to fetch" and CSP errors in the browser.
3) CONTENT-SECURITY-POLICY (CSP): If the app sets connect-src (Next.js headers, meta tag, or hosting config), the browser will BLOCK fetch() to Kolaybase unless EITHER:
   - the exact API origin of REST_BASE_URL is listed in connect-src (e.g. https://api.example.com), OR
   - the app only calls its own origin and a server-side Route Handler / backend proxies to Kolaybase (recommended for auth).
4) Symptom "Refused to connect … violates Content Security Policy directive: connect-src …" means CSP — not wrong password. Fix CSP or use a same-origin proxy — do not blame Kolaybase credentials first.

CONTEXT: Kolaybase is a managed platform. The database is PostgreSQL. The HTTP API is PostgREST-compatible (same patterns as Supabase REST: /rest/v1/{table}, headers apikey + optional Authorization Bearer).

--- PROJECT (REST / auth headers) ---
PROJECT_ID="${projectId}"
# Use header on Kolaybase REST auth and many client flows: x-project-id: <PROJECT_ID> (together with apikey: ANON_KEY)

--- BROWSER / CORS & REST AUTH (read carefully) ---
Hosted Kolaybase APIs may only allow browser requests from specific origins (e.g. the official admin app). If the user runs a SPA on http://localhost:* or their own domain, direct fetch() from the browser to REST_BASE_URL can fail with CORS — that is not an "invalid key" problem; fix it by calling the API from a server (Next.js Route Handler, backend) that proxies to REST_BASE_URL with headers apikey + x-project-id, and keep SERVICE_KEY only on the server.

For sign-in / sign-up against Kolaybase REST auth paths, do not rely on browser → Kolaybase from disallowed origins; use a same-origin API route that forwards JSON to the platform.

If there is NO CORS error (e.g. server-side or proxy) but auth still returns 401 Invalid credentials, that is separate from CORS — then check passwords, user provisioning, and Keycloak/realm health; hosted customers may need platform support after DB/realm rebuilds.

--- POSTGRESQL — DIRECT (no pooler; use only on same private network / internal) ---
DATABASE_URL_DIRECT="${conn.uri}"
host="${conn.host}"
port=${conn.port}
database="${conn.database}"
user="${conn.user}"
password="${conn.password}"

--- POSTGRESQL — POOLER (PgBouncer; preferred for Prisma, Drizzle, server apps) ---
DATABASE_URL_POOLER="${conn.poolerUri}"
pooler_host="${conn.poolerHost}"
pooler_port=${conn.poolerPort}

--- HTTP REST API ---
REST_BASE_URL="${conn.restUrl}"
# Public anon JWT — ok for browser/client if RLS policies allow
ANON_KEY="${conn.anonKey}"
# Service role — SERVER-SIDE ONLY; full DB access; never expose in frontend or public repos
SERVICE_KEY="${conn.serviceKey}"

Example REST GET (read):
GET \${REST_BASE_URL}/your_table?select=*&limit=10
Headers: apikey: <ANON_KEY or SERVICE_KEY>, Accept: application/json

--- AUTH (Keycloak) ---
KEYCLOAK_URL="${conn.keycloakUrl}"
KEYCLOAK_REALM="${conn.keycloakRealm}"

DELIVERABLES I WANT FROM YOU:
1) Exact .env (or .env.local) variable names and values I should paste (include PROJECT_ID where relevant). Use REST_BASE_URL exactly as quoted for API base — no localhost unless it appears in the quote.
2) If I use Prisma: the datasource url line using DATABASE_URL_POOLER unless I said I am internal-only, then DATABASE_URL_DIRECT.
3) If I use fetch/axios from a server: base URL + which key to use (anon vs service) for my scenario + x-project-id when calling Kolaybase REST auth.
4) If I use a browser SPA or Next.js client: explain CORS limits AND Content-Security-Policy connect-src; either extend connect-src to include the REST_BASE_URL origin or implement a same-origin API proxy for REST and auth — never expose SERVICE_KEY to the client.
5) If the stack is Next.js: show where to add connect-src in next.config headers OR recommend proxy-only pattern so the browser never talks to Kolaybase directly.
6) Remind me once: never commit SERVICE_KEY or database password to git.

Use the quoted values exactly; do not substitute placeholders.`;
}

function CopyBlock({
  label,
  value,
  icon: Icon,
  mono = true,
}: {
  label: string;
  value: string;
  icon?: React.ElementType;
  mono?: boolean;
}) {
  function copy() {
    navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          {label}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={copy}
          className="h-7 px-2 text-xs"
        >
          <Copy className="mr-1.5 h-3 w-3" />
          Copy
        </Button>
      </div>
      <div className="px-4 py-3">
        <code className={`text-sm break-all ${mono ? 'font-mono' : ''}`}>
          {value}
        </code>
      </div>
    </div>
  );
}

function CodeExample({
  label,
  language,
  code,
}: {
  label: string;
  language: string;
  code: string;
}) {
  function copy() {
    navigator.clipboard.writeText(code);
    toast.success(`${label} copied`);
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Code className="h-4 w-4 text-muted-foreground" />
          {label}
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {language}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={copy}
          className="h-7 px-2 text-xs"
        >
          <Copy className="mr-1.5 h-3 w-3" />
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto px-4 py-3">
        <code className="text-sm font-mono text-muted-foreground whitespace-pre">
          {code}
        </code>
      </pre>
    </div>
  );
}

export function ConnectionStringsView({
  projectId,
}: ConnectionStringsViewProps) {
  const [conn, setConn] = useState<ConnectionStrings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.projects
      .connect(projectId)
      .then(setConn)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading || !conn) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const aiQuickConnectPrompt = buildAiQuickConnectPrompt(conn, projectId);

  const curlExample = `curl '${conn.restUrl}/your_table?select=*&limit=10' \\
  -H 'apikey: ${conn.anonKey}'`;

  const fetchExample = `const res = await fetch(
  '${conn.restUrl}/your_table?select=*&limit=10',
  {
    headers: {
      'apikey': '${conn.anonKey}',
      'Content-Type': 'application/json',
    },
  }
);
const { data, count } = await res.json();`;

  const insertExample = `curl -X POST '${conn.restUrl}/your_table' \\
  -H 'apikey: ${conn.serviceKey}' \\
  -H 'Content-Type: application/json' \\
  -H 'Prefer: return=representation' \\
  -d '{"name": "example", "value": 42}'`;

  const prismaExample = `// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = "${conn.poolerUri}"
}`;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">Connection</h1>

      {/* Direct Database Connection (PgBouncer) */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Layers className="h-5 w-5" />
          Direct Connection (Pooler)
        </h2>
        <p className="text-sm text-muted-foreground">
          Connect directly to your database with connection pooling via
          PgBouncer. Use this for Prisma, Drizzle, pgAdmin, or any PostgreSQL
          client.
        </p>
        <CopyBlock
          label="Pooler Connection URI"
          value={conn.poolerUri}
          icon={Link2}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyBlock
            label="Pooler Host"
            value={conn.poolerHost}
            icon={Database}
          />
          <CopyBlock
            label="Pooler Port"
            value={String(conn.poolerPort)}
            icon={Database}
          />
          <CopyBlock label="Database" value={conn.database} icon={Database} />
          <CopyBlock label="User" value={conn.user} icon={Database} />
          <CopyBlock label="Password" value={conn.password} icon={Key} />
        </div>
        <CodeExample label="Prisma" language="prisma" code={prismaExample} />
      </section>

      {/* REST API */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Globe className="h-5 w-5" />
          REST API
        </h2>
        <p className="text-sm text-muted-foreground">
          Access your data via a PostgREST-compatible HTTP API. Use <code className="rounded bg-muted px-1">anon key</code> for
          read-only access and <code className="rounded bg-muted px-1">service key</code> for full CRUD.
        </p>
        <CopyBlock label="REST URL" value={conn.restUrl} icon={Globe} />

        <div className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            Query Examples
          </h3>
          <CodeExample label="Select (curl)" language="bash" code={curlExample} />
          <CodeExample
            label="Select (JavaScript)"
            language="javascript"
            code={fetchExample}
          />
          <CodeExample
            label="Insert (curl with service key)"
            language="bash"
            code={insertExample}
          />
        </div>

        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-800 dark:bg-amber-950">
          <p className="font-medium text-amber-800 dark:text-amber-200">
            Filter syntax
          </p>
          <ul className="mt-1.5 list-inside list-disc text-amber-700 dark:text-amber-300 space-y-1">
            <li>
              <code className="text-xs">?id=eq.5</code> -- equality
            </li>
            <li>
              <code className="text-xs">?name=ilike.*john*</code> -- case-insensitive search
            </li>
            <li>
              <code className="text-xs">?age=gt.18&age=lt.65</code> -- range
            </li>
            <li>
              <code className="text-xs">?status=in.(active,pending)</code> -- in list
            </li>
            <li>
              <code className="text-xs">?order=created_at.desc&limit=20</code> -- sort and paginate
            </li>
          </ul>
        </div>
      </section>

      {/* Authentication */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Shield className="h-5 w-5" />
          Authentication
        </h2>
        <CopyBlock
          label="Keycloak Realm"
          value={conn.keycloakRealm}
          icon={Shield}
        />
        <CopyBlock
          label="Keycloak URL"
          value={conn.keycloakUrl}
          icon={Link2}
        />
      </section>

      {/* API Keys */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Key className="h-5 w-5" />
          API Keys
        </h2>
        <CopyBlock
          label="Anon Key (public, read-only)"
          value={conn.anonKey}
          icon={Key}
        />
        <CopyBlock
          label="Service Key (secret, full access)"
          value={conn.serviceKey}
          icon={Key}
        />
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-800 dark:bg-red-950">
          <p className="font-medium text-red-800 dark:text-red-200">
            Keep your service key secret
          </p>
          <p className="mt-1 text-red-700 dark:text-red-300">
            Never expose it in client-side code or public repositories. Use it
            only in server-side applications.
          </p>
        </div>
      </section>

      {/* Internal Direct Connection (for reference) */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-muted-foreground">
          <Database className="h-5 w-5" />
          Internal Connection (no pooler)
        </h2>
        <p className="text-sm text-muted-foreground">
          Direct connection without pooler. Only use if you are inside the same
          network.
        </p>
        <CopyBlock label="Direct URI" value={conn.uri} icon={Link2} />

        <div className="rounded-lg border border-violet-200/80 bg-violet-50/50 dark:border-violet-900/60 dark:bg-violet-950/25">
          <div className="flex flex-col gap-1 border-b border-violet-200/80 px-4 py-3 dark:border-violet-900/50 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex gap-3 min-w-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-violet-100 dark:bg-violet-900/50">
                <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-300" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-violet-950 dark:text-violet-100">
                  AI prompt for quick connect
                </h3>
                <p className="mt-0.5 text-xs text-violet-800/90 dark:text-violet-200/80">
                  Copy into your AI assistant. The block states that hosts below are the real
                  Kolaybase deployment (often production)—not localhost—and covers CSP
                  (connect-src), CORS, and server-side proxying so sign-in does not hit
                  blocked or wrong URLs.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 border-violet-200 bg-white hover:bg-violet-50 dark:border-violet-800 dark:bg-violet-950 dark:hover:bg-violet-900"
              onClick={() => {
                navigator.clipboard.writeText(aiQuickConnectPrompt);
                toast.success('AI prompt copied');
              }}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy prompt
            </Button>
          </div>
          <div className="relative">
            <pre className="max-h-[min(320px,45vh)] overflow-auto px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:text-xs">
              <code className="font-mono whitespace-pre-wrap break-words">
                {aiQuickConnectPrompt}
              </code>
            </pre>
          </div>
          <p className="border-t border-violet-200/60 px-4 py-2 text-[11px] text-violet-800/80 dark:border-violet-900/50 dark:text-violet-300/80">
            This text includes database passwords and API keys. Only paste into tools you
            trust; do not share in public channels.
          </p>
        </div>
      </section>
    </div>
  );
}
