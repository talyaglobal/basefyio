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
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  ChevronDown,
  ChevronRight,
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

/** Dotenv-style line without wrapping the value in quotes (clean copy-paste for .env). */
function formatDotenvLine(key: string, value: string): string {
  return `${key}=${value}`;
}

/** When API returns localhost DB but publicBaseUrl is a real host, rewrite URIs for remote dev. */
function rewriteLocalhostInPgUri(uri: string, replacementHost: string | null): string {
  if (!replacementHost) return uri;
  try {
    const u = new URL(uri);
    if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return uri;
    u.hostname = replacementHost;
    return u.toString();
  } catch {
    return uri;
  }
}

function frameworkPresetLabel(preset: FrameworkPreset): string {
  switch (preset) {
    case 'nextjs':
      return 'Next.js';
    case 'vite':
      return 'Vite';
    case 'react-native':
      return 'React Native (Expo)';
    case 'node':
      return 'Node.js';
    default:
      return preset;
  }
}

/**
 * Short, actionable prompt for AI assistants: same env as Raw Editor + migration + REST rules.
 */
function buildAiQuickConnectPrompt(
  envBlockOneLinePerVar: string,
  frameworkPreset: FrameworkPreset,
): string {
  const stack = frameworkPresetLabel(frameworkPreset);
  return `You are helping in the user's repo. Wire the app to basefyio using ONLY the environment block below (real basefyio URLs and keys — not fake placeholders).

## 0) Authentication — read this first
- Do **not** install, docker-compose, or run **Keycloak** inside the user's project. There is **no** local Keycloak requirement for login.
- **basefyio is the auth surface**: sign-in and API access go through basefyio (the base URL and anon/service keys in the env block). Implement login and protected calls using basefyio as the backend auth provider — the same hosted Keycloak that powers basefyio is already behind that service; the app should consume basefyio APIs/keys, not stand up a separate IdP.
- **JavaScript / TypeScript apps**: use the official **basefyio-js** SDK (\`npm install basefyio-js\`, then \`createClient\` with \`apiUrl\`, \`projectId\`, and \`apiKey\` from the env block). Use **\`basefyio.auth\`** (signUp, signIn, signOut, OAuth helpers, etc.) for authentication — that is the supported basefyio auth path. Do **not** point \`@supabase/supabase-js\` or other Supabase clients at basefyio URLs for auth unless the user explicitly asks for a custom low-level integration.
- Do **not** tell the user to "provision Keycloak", import realms, or mirror basefyio's internal Keycloak URLs unless they explicitly need low-level infra support from operators.

## 1) Append to .env or .env.local (copy exactly — each line is KEY=value with no quotes around values)
${envBlockOneLinePerVar}

## 2) Stack preset
${stack} (use the env names above; do not rename keys unless the framework strictly requires it).

## 3) When the user asks you to run migrations
- Ensure DATABASE_URL and DIRECT_URL are in .env (exactly as above).
- From the project root, run their migration command (e.g. npx supabase db push, npm run db:push:basefyio, or prisma migrate). The machine must reach the Postgres host in those URLs.
- Do not substitute hosts or passwords.

## 4) REST / basefyio API
- **JS/TS (preferred):** use **basefyio-js** \`createClient\` with the env block; use \`basefyio.from(...)\` for tables and \`basefyio.auth\` for auth (same client).
- **Raw HTTP (only if not using the SDK):** browser/client requests use the public URL + anon key from the block; send headers \`apikey\` and \`x-project-id\` with PROJECT_ID per API docs.
- Service role key: server-side only; never expose to client bundles or public repos.

## 5) Official documentation (learn basefyio before inventing patterns)
Use these public URLs for product behavior, SDK, CLI, and REST conventions. Prefer them over generic third-party BaaS guesses when they conflict:
- Docs home / overview: https://basefyio.com/docs
- API reference (REST, auth, headers, projects): https://basefyio.com/docs/api
- JavaScript/TypeScript SDK: https://basefyio.com/docs/sdk
- CLI (basefyio login, link, projects): https://basefyio.com/docs/cli

The user's live base URL, keys, and PROJECT_ID still come **only** from the env block in this prompt — docs explain *how* to use them, not replacement values.

## 6) CORS / CSP
If the browser blocks the API origin, fix connect-src / CORS or use a same-origin proxy — do not silently change the basefyio URLs to unrelated domains.

## 7) Do not
Echo full secrets in your reply, invent fake values, or commit .env to git.`;
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
  const [activeTab, setActiveTab] = useState<'raw' | 'basefyio'>('raw');
  const [framework, setFramework] = useState<FrameworkPreset>('nextjs');
  const [rawEditorFormat, setRawEditorFormat] = useState<RawEditorFormat>('env');
  const [nextPassword, setNextPassword] = useState('');
  const [rotatingPassword, setRotatingPassword] = useState(false);
  const [showKeycloakDetails, setShowKeycloakDetails] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);

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
  const replacementHost =
    conn.host === 'localhost' || conn.host === '127.0.0.1'
      ? publicHostname
      : null;
  const restBaseUrl = `${conn.publicBaseUrl}/api/proxy`;
  const pooledUrl = rewriteLocalhostInPgUri(conn.poolerUri, replacementHost);
  const directUrl = rewriteLocalhostInPgUri(conn.uri, replacementHost);

  const baseVars = {
    DATABASE_URL: pooledUrl,
    DIRECT_URL: directUrl,
    NEXT_PUBLIC_BASEFYIO_URL: restBaseUrl,
    NEXT_PUBLIC_BASEFYIO_ANON_KEY: conn.anonKey,
    BASEFYIO_SERVICE_ROLE_KEY: conn.serviceKey,
    PROJECT_ID: projectId,
  } as const;

  const frameworkVars: Record<FrameworkPreset, Record<string, string>> = {
    nextjs: {
      NEXT_PUBLIC_BASEFYIO_URL: baseVars.NEXT_PUBLIC_BASEFYIO_URL,
      NEXT_PUBLIC_BASEFYIO_ANON_KEY: baseVars.NEXT_PUBLIC_BASEFYIO_ANON_KEY,
      BASEFYIO_SERVICE_ROLE_KEY: baseVars.BASEFYIO_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
    vite: {
      VITE_BASEFYIO_URL: baseVars.NEXT_PUBLIC_BASEFYIO_URL,
      VITE_BASEFYIO_ANON_KEY: baseVars.NEXT_PUBLIC_BASEFYIO_ANON_KEY,
      BASEFYIO_SERVICE_ROLE_KEY: baseVars.BASEFYIO_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
    'react-native': {
      EXPO_PUBLIC_BASEFYIO_URL: baseVars.NEXT_PUBLIC_BASEFYIO_URL,
      EXPO_PUBLIC_BASEFYIO_ANON_KEY: baseVars.NEXT_PUBLIC_BASEFYIO_ANON_KEY,
      BASEFYIO_SERVICE_ROLE_KEY: baseVars.BASEFYIO_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
    node: {
      BASEFYIO_URL: baseVars.NEXT_PUBLIC_BASEFYIO_URL,
      BASEFYIO_ANON_KEY: baseVars.NEXT_PUBLIC_BASEFYIO_ANON_KEY,
      BASEFYIO_SERVICE_ROLE_KEY: baseVars.BASEFYIO_SERVICE_ROLE_KEY,
      DATABASE_URL: baseVars.DATABASE_URL,
      DIRECT_URL: baseVars.DIRECT_URL,
      PROJECT_ID: baseVars.PROJECT_ID,
    },
  };

  const selectedVars = frameworkVars[framework];
  const rawEnvContent = Object.entries(selectedVars)
    .map(([key, value]) => formatDotenvLine(key, value))
    .join('\n');
  const rawJsonContent = JSON.stringify(selectedVars, null, 2);
  const rawEditorContent = rawEditorFormat === 'env' ? rawEnvContent : rawJsonContent;

  const aiQuickConnectPrompt = buildAiQuickConnectPrompt(rawEnvContent, framework);

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
      setNextPassword(result.password);
      const fresh = await api.projects.connect(projectId);
      setConn(fresh);
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
          onClick={() => setActiveTab('basefyio')}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            activeTab === 'basefyio'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          basefyio Details
        </button>
      </div>

      {activeTab === 'raw' && (
        <section className="space-y-4 rounded-xl border bg-card p-6">
          <div>
            <h2 className="text-lg font-semibold">Raw Editor</h2>
            <p className="text-sm text-muted-foreground">
              Add, edit, or copy your project variables in ENV or JSON format. In ENV mode each
              line is <code className="rounded bg-muted px-1 py-0.5 text-xs">KEY=value</code> with
              no quotes around values so you can paste straight into{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">.env</code>.
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              <code className="rounded bg-muted px-1 py-0.5 text-xs">DATABASE_URL</code> uses the
              connection pool (PgBouncer). <code className="rounded bg-muted px-1 py-0.5 text-xs">DIRECT_URL</code>{' '}
              targets Postgres directly for Prisma migrate and hosted vendor CLI (
              <code className="rounded bg-muted px-1 py-0.5 text-xs">db push</code>
              ); when no separate public Postgres port is configured, both URLs match. The project
              database role includes permission to create migration history schemas.
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
                    Copy into your AI assistant. Wraps the exact ENV block above (byte-identical
                    values) plus instructions on auth via basefyio-js, migrations, REST/fetch
                    fallback, CORS/CSP, and safe handling of secrets.
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
      )}

      {activeTab === 'basefyio' && (
      <>
      {/* External Database Access */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Database className="h-5 w-5" />
          External Database Access
        </h2>
        <p className="text-sm text-muted-foreground">
          Connect from any database client — pgAdmin, DBeaver, DataGrip, TablePlus, or your terminal.
          Copy the connection string or use the individual fields below.
        </p>
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm dark:border-blue-800 dark:bg-blue-950">
          <p className="font-medium text-blue-800 dark:text-blue-200">Quick connect</p>
          <ul className="mt-1.5 list-inside list-disc text-blue-700 dark:text-blue-300 space-y-1">
            <li><strong>pgAdmin:</strong> Add Server → Connection tab → paste Host, Port, Database, Username, Password below</li>
            <li><strong>DBeaver:</strong> New Connection → select PostgreSQL → paste Host, Port, Database, Username, Password</li>
            <li><strong>Terminal:</strong> <code className="rounded bg-blue-100 dark:bg-blue-900 px-1 text-xs">psql &quot;{conn.poolerUri}&quot;</code></li>
          </ul>
        </div>
      </section>

      {/* Connection Details */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Layers className="h-5 w-5" />
          Connection Details (Pooler)
        </h2>
        <p className="text-sm text-muted-foreground">
          Connection pooling endpoint. Use this for Prisma, Drizzle, pgAdmin, DBeaver, or any SQL client.
        </p>
        <CopyBlock
          label="Pooler Connection URI"
          value={conn.poolerUri}
          icon={Link2}
        />
        <div className="basefyio-grid-row-hover grid gap-3 sm:grid-cols-2">
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
        {conn.canResetDbPassword && (
          <Button
            variant="outline"
            onClick={() => { setNextPassword(''); setShowPasswordModal(true); }}
            className="gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Reset database password
          </Button>
        )}

        <Dialog open={showPasswordModal} onOpenChange={setShowPasswordModal}>
          <DialogContent className="max-w-md">
            <DialogTitle>Reset Database Password</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Enter your own strong password or generate a secure one.
              Active connections will be disconnected.
            </p>
            <div className="space-y-4 pt-2">
              <div className="flex gap-2">
                <Input
                  type="text"
                  placeholder="Enter new password"
                  value={nextPassword}
                  onChange={(e) => setNextPassword(e.target.value)}
                  aria-label="New database password"
                  className="flex-1 font-mono"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setNextPassword(generateStrongPassword())}
                  disabled={rotatingPassword}
                >
                  Generate
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
              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  onClick={async () => {
                    await handleRotatePassword(false);
                    setShowPasswordModal(false);
                  }}
                  disabled={rotatingPassword || nextPassword.length === 0}
                  className="flex-1"
                >
                  {rotatingPassword ? 'Resetting...' : 'Reset password'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={async () => {
                    await handleRotatePassword(true);
                    setShowPasswordModal(false);
                  }}
                  disabled={rotatingPassword}
                  className="flex-1"
                >
                  {rotatingPassword ? 'Resetting...' : 'Auto-generate'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        <CodeExample label="Prisma" language="prisma" code={prismaExample} />
      </section>

      {/* REST API */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Globe className="h-5 w-5" />
          REST API
        </h2>
        <p className="text-sm text-muted-foreground">
          Access your data via a REST API. Use <code className="rounded bg-muted px-1">anon key</code> for
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
        <p className="text-sm text-muted-foreground">
          Sign-in for this project is handled by basefyio (hosted auth behind the REST URL and keys
          above). You do not run Keycloak in your own repo for normal integration.
        </p>
        <button
          type="button"
          onClick={() => setShowKeycloakDetails((open) => !open)}
          className="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted/50"
          aria-expanded={showKeycloakDetails}
        >
          <span className="min-w-0">
            Keycloak realm and URL <span className="font-normal text-muted-foreground">(optional)</span>
          </span>
          {showKeycloakDetails ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
        </button>
        {showKeycloakDetails ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Internal basefyio identifiers for this project&apos;s realm. Expand only if you need
              them for support or advanced debugging — not required for app login wiring.
            </p>
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
          </div>
        ) : null}
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
      </>
      )}
    </div>
  );
}
