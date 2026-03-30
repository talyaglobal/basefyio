'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import type { ConnectionStrings } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
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
  RefreshCw,
} from 'lucide-react';

interface ConnectionStringsViewProps {
  projectId: string;
}

type FrameworkPreset = 'nextjs' | 'vite' | 'react-native' | 'node';
type RawEditorFormat = 'env' | 'json';

const passwordSchema = z
  .string()
  .min(12, 'At least 12 characters')
  .regex(/[a-z]/, 'At least one lowercase letter')
  .regex(/[A-Z]/, 'At least one uppercase letter')
  .regex(/[0-9]/, 'At least one number')
  .regex(/[^A-Za-z0-9]/, 'At least one special character')
  .regex(/^\S+$/, 'No spaces allowed');

function generateStrongPassword(length = 24): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$%^&*()-_=+[]{};:,.?';
  const all = `${lower}${upper}${digits}${symbols}`;
  const pick = (chars: string) => chars[Math.floor(Math.random() * chars.length)];

  const seeded = [
    pick(lower),
    pick(upper),
    pick(digits),
    pick(symbols),
  ];

  for (let i = seeded.length; i < length; i += 1) {
    seeded.push(pick(all));
  }

  for (let i = seeded.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [seeded[i], seeded[j]] = [seeded[j], seeded[i]];
  }

  return seeded.join('');
}

function getHostnameFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * Single copy-paste block for ChatGPT, Claude, Cursor, etc. so the model can
 * wire up env vars, ORMs, or REST clients without guessing.
 */
function buildAiQuickConnectPrompt(
  conn: ConnectionStrings,
  projectId: string,
): string {
  return `You are configuring a production app to connect to Kolaybase.
Use ONLY the exact values below. Do NOT replace with localhost, examples, or placeholders.

## Project Values (source of truth)
PROJECT_ID="${projectId}"
DATABASE_URL_POOLER="${conn.poolerUri}"
DATABASE_URL_DIRECT="${conn.uri}"
REST_BASE_URL="${conn.restUrl}"
ANON_KEY="${conn.anonKey}"
SERVICE_KEY="${conn.serviceKey}"
KEYCLOAK_URL="${conn.keycloakUrl}"
KEYCLOAK_REALM="${conn.keycloakRealm}"

## Critical Rules
1) Treat these as production values.
2) Never change host, port, keys, or project id.
3) SERVICE_KEY must stay server-side only.
4) If browser calls are blocked by CORS/CSP, use a same-origin backend proxy.
5) For Kolaybase REST/Auth requests include:
   - apikey: <ANON_KEY or SERVICE_KEY>
   - x-project-id: <PROJECT_ID>

## What to generate
1) Ready-to-paste .env/.env.local block.
2) Minimal working setup for my stack (client + server where needed).
3) Prisma datasource config using DATABASE_URL_POOLER (use DIRECT only if explicitly asked).
4) Example API request using REST_BASE_URL with correct headers.
5) Short verification checklist (how to confirm connection works).

## Important
- Do not invent new env names unless required by the chosen framework.
- Do not output fake values.
- Reminder: never commit SERVICE_KEY or DB password to git.`;
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
  const [activeTab, setActiveTab] = useState<'raw' | 'kolaybase'>('raw');
  const [framework, setFramework] = useState<FrameworkPreset>('nextjs');
  const [rawEditorFormat, setRawEditorFormat] = useState<RawEditorFormat>('env');
  const [nextPassword, setNextPassword] = useState('');
  const [rotatingPassword, setRotatingPassword] = useState(false);

  useEffect(() => {
    api.projects
      .connect(projectId)
      .then(setConn)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  const isLocalPublicBase = conn
    ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(conn.publicBaseUrl)
    : false;

  useEffect(() => {
    if (!loading && activeTab === 'raw' && isLocalPublicBase) {
      toast.warning(
        'publicBaseUrl resolves to localhost. Check your PUBLIC_API_URL for production.',
      );
    }
  }, [loading, activeTab, isLocalPublicBase]);

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
  const publicHostname = getHostnameFromUrl(conn.publicBaseUrl);
  const connectionHost =
    conn.host === 'localhost' || conn.host === '127.0.0.1'
      ? publicHostname || conn.host
      : conn.host;
  const connectionPort = conn.poolerPort || conn.port;
  const restBaseUrl = `${conn.publicBaseUrl}/api/proxy`;
  const pooledUrl = `postgresql://${conn.user}:${conn.password}@${connectionHost}:${connectionPort}/${conn.database}`;
  const directUrl = `postgresql://${conn.user}:${conn.password}@${connectionHost}:${conn.port}/${conn.database}`;

  const baseVars = {
    DATABASE_URL: pooledUrl,
    DIRECT_URL: directUrl,
    NEXT_PUBLIC_SUPABASE_URL: restBaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: conn.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: conn.serviceKey,
    PROJECT_ID: projectId,
  } as const;

  const frameworkVars: Record<FrameworkPreset, Record<string, string>> = {
    nextjs: {
      NEXT_PUBLIC_SUPABASE_URL: baseVars.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: baseVars.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: baseVars.SUPABASE_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
    vite: {
      VITE_SUPABASE_URL: baseVars.NEXT_PUBLIC_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: baseVars.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: baseVars.SUPABASE_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
    'react-native': {
      EXPO_PUBLIC_SUPABASE_URL: baseVars.NEXT_PUBLIC_SUPABASE_URL,
      EXPO_PUBLIC_SUPABASE_ANON_KEY: baseVars.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: baseVars.SUPABASE_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
    node: {
      SUPABASE_URL: baseVars.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_ANON_KEY: baseVars.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: baseVars.SUPABASE_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
  };

  const selectedVars = frameworkVars[framework];
  const rawEnvContent = Object.entries(selectedVars)
    .map(([key, value]) => `${key}="${value}"`)
    .join('\n');
  const rawJsonContent = JSON.stringify(selectedVars, null, 2);
  const rawEditorContent = rawEditorFormat === 'env' ? rawEnvContent : rawJsonContent;

  const passwordValidation =
    nextPassword.length === 0
      ? null
      : passwordSchema.safeParse(nextPassword);

  async function handleRotatePassword(useGenerated: boolean) {
    const candidate = useGenerated ? undefined : nextPassword;
    if (!useGenerated) {
      const parsed = passwordSchema.safeParse(nextPassword);
      if (!parsed.success) {
        toast.error(parsed.error.issues[0]?.message || 'Invalid password');
        return;
      }
    }

    setRotatingPassword(true);
    try {
      const result = await api.projects.rotateDbPassword(projectId, candidate);
      setConn((prev) => {
        if (!prev) return prev;
        const nextUri = `postgresql://${prev.user}:${result.password}@${prev.host}:${prev.port}/${prev.database}`;
        const nextPoolerUri = `postgresql://${prev.user}:${result.password}@${prev.poolerHost}:${prev.poolerPort}/${prev.database}`;
        return {
          ...prev,
          password: result.password,
          uri: nextUri,
          poolerUri: nextPoolerUri,
        };
      });
      setNextPassword(result.password);
      toast.success('Database password reset');
    } catch (err: any) {
      toast.error(err.message || 'Password reset failed');
    } finally {
      setRotatingPassword(false);
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold tracking-tight">Connection</h1>
      <div className="inline-flex rounded-lg border bg-muted/40 p-1">
        <button
          type="button"
          onClick={() => setActiveTab('raw')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            activeTab === 'raw'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Raw Editor
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('kolaybase')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            activeTab === 'kolaybase'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          Kolaybase Details
        </button>
      </div>

      {activeTab === 'raw' && (
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <div>
            <h2 className="text-lg font-semibold">Raw Editor</h2>
            <p className="text-sm text-muted-foreground">
              Add, edit, or copy your project variables in ENV or JSON format.
            </p>
          </div>
          {isLocalPublicBase && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Production warning: `publicBaseUrl` resolves to localhost
              (<code className="mx-1 rounded bg-amber-100 px-1 py-0.5 dark:bg-amber-900">{conn.publicBaseUrl}</code>).
              For production, set backend `PUBLIC_API_URL` to your public domain.
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
            <Select
              value={framework}
              onValueChange={(value) => setFramework(value as FrameworkPreset)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select framework" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nextjs">Next.js</SelectItem>
                <SelectItem value="vite">Vite</SelectItem>
                <SelectItem value="react-native">React Native (Expo)</SelectItem>
                <SelectItem value="node">Node.js</SelectItem>
              </SelectContent>
            </Select>
            <div className="inline-flex rounded-md border bg-muted/30 p-1 w-fit">
              <button
                type="button"
                onClick={() => setRawEditorFormat('env')}
                className={cn(
                  'rounded px-3 py-1 text-sm',
                  rawEditorFormat === 'env'
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                ENV
              </button>
              <button
                type="button"
                onClick={() => setRawEditorFormat('json')}
                className={cn(
                  'rounded px-3 py-1 text-sm',
                  rawEditorFormat === 'json'
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                JSON
              </button>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/10">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <p className="text-sm font-medium">
                {rawEditorFormat.toUpperCase()} variables
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(rawEditorContent);
                  toast.success(`Copy ${rawEditorFormat.toUpperCase()}`);
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy {rawEditorFormat.toUpperCase()}
              </Button>
            </div>
            <pre className="max-h-[420px] overflow-auto px-4 py-3">
              <code className="whitespace-pre text-sm text-emerald-400">
                {rawEditorContent}
              </code>
            </pre>
          </div>
        </section>
      )}

      {activeTab === 'kolaybase' && (
      <>
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
          <CopyBlock label="Project ID" value={projectId} icon={Database} />
        </div>
        <div className="rounded-md border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
            Reset database password
          </div>
          <p className="text-xs text-muted-foreground">
            Enter your own strong password or generate a secure one.
          </p>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <Input
              type="text"
              placeholder="Enter new password"
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
              aria-label="New database password"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => setNextPassword(generateStrongPassword())}
              disabled={rotatingPassword}
            >
              Generate
            </Button>
            <Button
              type="button"
              onClick={() => handleRotatePassword(false)}
              disabled={rotatingPassword || nextPassword.length === 0}
            >
              {rotatingPassword ? 'Resetting...' : 'Reset'}
            </Button>
          </div>
          {passwordValidation && !passwordValidation.success && (
            <p className="text-xs text-red-600">
              {passwordValidation.error.issues[0]?.message}
            </p>
          )}
          <ul className="list-disc list-inside text-xs text-muted-foreground space-y-1">
            <li>Minimum 12 characters</li>
            <li>At least one uppercase and one lowercase letter</li>
            <li>At least one number and one special character</li>
            <li>No spaces allowed</li>
          </ul>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleRotatePassword(true)}
            disabled={rotatingPassword}
          >
            {rotatingPassword ? 'Resetting...' : 'Generate and reset automatically'}
          </Button>
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
      </>
      )}
    </div>
  );
}
