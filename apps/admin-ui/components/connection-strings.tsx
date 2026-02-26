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
} from 'lucide-react';

interface ConnectionStringsViewProps {
  projectId: string;
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
      </section>
    </div>
  );
}
