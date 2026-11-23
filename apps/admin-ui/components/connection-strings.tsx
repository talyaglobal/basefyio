'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { api } from '@/lib/api';
import type { ConnectionSecrets, ConnectionStrings } from '@/lib/types';
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
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { ApiKeysPanel } from '@/components/api-keys-panel';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  Eye,
  EyeOff,
  Key,
  Link2,
  Shield,
  Globe,
  Terminal,
  Code,
  Layers,
  Sparkles,
  RefreshCw,
  UserPlus,
  Users,
} from 'lucide-react';

interface ConnectionStringsViewProps {
  projectId: string;
}

type FrameworkPreset = 'nextjs' | 'vite' | 'react-native' | 'node';
type RawEditorFormat = 'env' | 'json';

const passwordSchema = z
  .string()
  .min(8, 'At least 8 characters')
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
  return `You are helping in the user's repo. This project uses **basefyio** as its database and backend. All data lives on basefyio — there is NO local database.

## CRITICAL — No local database
- The database is **hosted on basefyio** (see DATABASE_URL below). Do **NOT** create, install, or run a local PostgreSQL / SQLite / MySQL / Docker database.
- Do **NOT** run \`docker-compose up\`, \`docker run postgres\`, or any command that starts a local database server.
- Do **NOT** change DATABASE_URL to \`localhost\`, \`127.0.0.1\`, or any local address. The URL below points to the user's live basefyio project — use it as-is.
- Do **NOT** create a new database. The database already exists on basefyio and may contain production data.
- If a tool suggests "creating a database first", skip that step — the database is already provisioned.

## 0) Authentication — read this first
- Do **not** install, docker-compose, or run a **separate auth server** inside the user's project. There is **no** local auth requirement.
- **basefyio is the auth surface**: sign-in and API access go through basefyio (the base URL and anon/service keys in the env block). Implement login and protected calls using basefyio as the backend auth provider.
- **JavaScript / TypeScript apps**: use the official **basefyio-js** SDK (\`npm install basefyio-js\`, then \`createClient\` with \`apiUrl\`, \`projectId\`, and \`apiKey\` from the env block). Use **\`basefyio.auth\`** for authentication.
- Do **not** tell the user to provision a separate auth server, import realms, or stand up a separate identity provider.

## 1) Environment variables (copy exactly — no quotes around values)
${envBlockOneLinePerVar}

## 2) Stack preset
${stack} (use the env names above; do not rename keys unless the framework strictly requires it).

## 3) Prisma / Drizzle / ORM — migrations and schema
- \`DATABASE_URL\` is the connection-pooled endpoint (for queries at runtime).
- \`DIRECT_URL\` is the direct connection (for \`prisma migrate\`, \`prisma db push\`, \`drizzle-kit push\`).
- Both point to the **remote basefyio database** — never replace them with local URLs.
- Run migrations against the remote database: \`npx prisma migrate dev\`, \`npx prisma db push\`, or \`npx drizzle-kit push\`.
- The basefyio database already has the \`public\` schema ready. Your ORM creates tables there.
- **Prisma schema example:**
  \`\`\`prisma
  datasource db {
    provider  = "postgresql"
    url       = env("DATABASE_URL")
    directUrl = env("DIRECT_URL")
  }
  \`\`\`
- After adding/changing models, run \`npx prisma db push\` (or \`migrate dev\`) — this runs against basefyio, not a local DB.
- To inspect existing tables: \`npx prisma db pull\` — this introspects the remote basefyio database.

## 4) REST / basefyio API
- **JS/TS (preferred):** use **basefyio-js** \`createClient\` with the env block; use \`basefyio.from(...)\` for tables and \`basefyio.auth\` for auth.
- **Raw HTTP:** send headers \`apikey\` and \`x-project-id\` with PROJECT_ID per API docs.
- Service role key: server-side only; never expose to client bundles or public repos.

## 5) External database tools
The user can also connect to their basefyio database from pgAdmin, DBeaver, DataGrip, TablePlus, or \`psql\` using the host, port, database, user, and password from DATABASE_URL. The database is always accessible — no VPN or tunnel needed.

## 6) Official documentation
- Docs home: https://docs.basefyio.com
- API reference: https://docs.basefyio.com/api
- SDK: https://docs.basefyio.com/sdk
- CLI: https://docs.basefyio.com/cli
- External DB access: https://docs.basefyio.com/connect

## 7) CORS / CSP
If the browser blocks the API origin, fix connect-src / CORS or use a same-origin proxy — do not change the basefyio URLs.

## 8) Do NOT
- Create or start a local database (PostgreSQL, SQLite, MySQL, Docker)
- Change DATABASE_URL or DIRECT_URL to localhost
- Echo full secrets in your reply
- Invent fake values or commit .env to git
- Install Supabase CLI or point Supabase clients at basefyio URLs`;
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

/** What a masked value shows on screen. */
const MASK = '••••••••••••';

/** `[YOUR-PASSWORD]` (the API's placeholder) shown as dots. */
function maskUri(uri: string): string {
  return uri.replace('[YOUR-PASSWORD]', '••••••••');
}

/**
 * A credential: masked by default. Reveal and Copy fetch the value on demand (each fetch is
 * recorded in the project's activity log) and keep it in memory only.
 */
function SecretCopyBlock({
  label,
  value,
  masked,
  icon: Icon,
  canReveal,
  onReveal,
}: {
  label: string;
  /** The value once revealed; null while masked or when it may not be shown. */
  value: string | null | undefined;
  masked: string;
  icon?: React.ElementType;
  canReveal: boolean;
  /** Fetches the credentials; resolves to this block's value, or null. */
  onReveal: () => Promise<string | null>;
}) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  // Values dropped after a rotation are fetched again; hide until then.
  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  async function resolve(): Promise<string | null> {
    if (value) return value;
    setBusy(true);
    try {
      return await onReveal();
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (visible) {
      setVisible(false);
      return;
    }
    if (await resolve()) setVisible(true);
  }

  async function copy() {
    const v = await resolve();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      toast.success(`${label} copied`);
    } catch {
      toast.error('The browser blocked the clipboard; try Copy again');
    }
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          {label}
        </div>
        {canReveal && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void toggle()}
              disabled={busy}
              className="h-7 px-2 text-xs"
              aria-label={visible ? `Hide ${label}` : `Reveal ${label}`}
            >
              {visible ? <EyeOff className="mr-1.5 h-3 w-3" /> : <Eye className="mr-1.5 h-3 w-3" />}
              {visible ? 'Hide' : 'Reveal'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void copy()} disabled={busy} className="h-7 px-2 text-xs">
              <Copy className="mr-1.5 h-3 w-3" />
              Copy
            </Button>
          </div>
        )}
      </div>
      <div className="px-4 py-3">
        <code className="text-sm break-all font-mono">{visible && value ? value : masked}</code>
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
  const [readonlyBusy, setReadonlyBusy] = useState(false);
  const [limitBusy, setLimitBusy] = useState(false);
  const [extraRoleBusy, setExtraRoleBusy] = useState<Record<string, boolean>>({});
  const [showCreateExtraRole, setShowCreateExtraRole] = useState(false);
  const [extraRoleLabel, setExtraRoleLabel] = useState('');
  const [extraRoleMemberOf, setExtraRoleMemberOf] = useState('none');
  const [creatingExtraRole, setCreatingExtraRole] = useState(false);
  // The credentials in clear, fetched on demand (#14) and kept in memory for this page only.
  const [secrets, setSecrets] = useState<ConnectionSecrets | null>(null);

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
  -H 'apikey: <your-secret-key>' \\
  -H 'Content-Type: application/json' \\
  -H 'Prefer: return=representation' \\
  -d '{"name": "example", "value": 42}'`;

  const prismaExample = `// prisma/schema.prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}`;
  const drizzleExample = `// db.ts — postgres-js; the pooler runs in transaction mode, so no prepared statements
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const client = postgres(process.env.DATABASE_URL!, { prepare: false });
export const db = drizzle(client);`;

  const typeormExample = `// data-source.ts
import { DataSource } from 'typeorm';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [],
});`;

  const sqlalchemyExample = `# db.py — psycopg2; DATABASE_URL uses the postgresql:// scheme
import os
from sqlalchemy import create_engine

engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)`;

  const publicHostname = getHostnameFromUrl(conn.publicBaseUrl);
  const replacementHost =
    conn.host === 'localhost' || conn.host === '127.0.0.1'
      ? publicHostname
      : null;
  const restBaseUrl = conn.publicBaseUrl;
  const canReveal = !!conn.canRevealSecrets;

  /**
   * The credentials, fetched once per page view on demand. Each fetch is recorded in the
   * project's activity log; nothing is stored beyond this component's state.
   */
  async function ensureSecrets(): Promise<ConnectionSecrets | null> {
    if (secrets) return secrets;
    if (!canReveal) {
      toast.error('Your role cannot see this project\'s credentials. Ask a team owner or admin.');
      return null;
    }
    try {
      const fresh = await api.projects.revealSecrets(projectId);
      setSecrets(fresh);
      return fresh;
    } catch (err: any) {
      toast.error(err.message || 'Could not reveal the credentials');
      return null;
    }
  }

  const SERVICE_KEY_PLACEHOLDER = '<your-secret-key>';
  const DB_PASSWORD_PLACEHOLDER = '[YOUR-PASSWORD]';

  /** The env variables; real values only when `values` holds revealed credentials. */
  function buildFrameworkVars(values: ConnectionSecrets | null): Record<string, string> {
    const pooled = rewriteLocalhostInPgUri(values?.poolerUri ?? conn!.poolerUri, replacementHost);
    const direct = rewriteLocalhostInPgUri(values?.uri ?? conn!.uri, replacementHost);
    // Only unprefixed variables carry the service key, which Vite (VITE_*) and Expo
    // (EXPO_PUBLIC_*) never put into a browser bundle.
    const serviceKey = values?.serviceKey ?? SERVICE_KEY_PLACEHOLDER;
    const publicPrefix: Record<FrameworkPreset, string> = {
      nextjs: 'NEXT_PUBLIC_BASEFYIO',
      vite: 'VITE_BASEFYIO',
      'react-native': 'EXPO_PUBLIC_BASEFYIO',
      node: 'BASEFYIO',
    };
    const prefix = publicPrefix[framework];
    return {
      [`${prefix}_URL`]: restBaseUrl,
      [`${prefix}_ANON_KEY`]: conn!.anonKey,
      BASEFYIO_SERVICE_ROLE_KEY: serviceKey,
      DATABASE_URL: pooled,
      DIRECT_URL: direct,
      PROJECT_ID: projectId,
    };
  }

  function formatVars(vars: Record<string, string>): string {
    return rawEditorFormat === 'env'
      ? Object.entries(vars)
          .map(([key, value]) => formatDotenvLine(key, value))
          .join('\n')
      : JSON.stringify(vars, null, 2);
  }

  // On screen the credentials are never shown: placeholders stand in for them. Copy fetches
  // the real values (when the role may see them) and puts them on the clipboard only.
  const shownEditorContent = formatVars(buildFrameworkVars(null)).split(DB_PASSWORD_PLACEHOLDER).join('••••••••');

  async function copyEditorContent() {
    const values = canReveal ? await ensureSecrets() : null;
    try {
      await navigator.clipboard.writeText(formatVars(buildFrameworkVars(values)));
    } catch {
      toast.error('The browser blocked the clipboard; try Copy again');
      return;
    }
    if (!values) {
      toast.success(`${rawEditorFormat.toUpperCase()} copied with placeholders for the password and the service key`);
    } else if (!values.serviceKey) {
      toast.success(
        `${rawEditorFormat.toUpperCase()} copied. The service key is in use, so it is not shown: rotate it or create a secret key under API keys.`,
      );
    } else {
      toast.success(`${rawEditorFormat.toUpperCase()} copied with its values — keep it out of version control`);
    }
  }

  // The prompt is pasted into a third-party assistant: it never carries the credentials.
  const promptEnvContent = Object.entries(buildFrameworkVars(null))
    .map(([key, value]) => formatDotenvLine(key, value))
    .join('\n')
    .split(DB_PASSWORD_PLACEHOLDER)
    .join('<db-password>');
  const aiQuickConnectPrompt = buildAiQuickConnectPrompt(promptEnvContent, framework);

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
      setSecrets(null);
      toast.success('Database password reset');
    } catch (err: any) {
      toast.error(err.message || 'Password reset failed');
    } finally {
      setRotatingPassword(false);
    }
  }

  async function refreshConnection() {
    const fresh = await api.projects.connect(projectId);
    setConn(fresh);
    // Passwords may have changed: fetch them again on the next Reveal or Copy.
    setSecrets(null);
  }

  async function handleReadonlyRole(action: 'create' | 'rotate' | 'remove') {
    if (action === 'remove') {
      const ok = await confirmDialog({
        title: 'Remove read-only role',
        description: 'Clients using the read-only credentials lose access immediately.',
        destructive: true,
      });
      if (!ok) return;
    }
    setReadonlyBusy(true);
    try {
      if (action === 'create') await api.projects.createReadonlyRole(projectId);
      else if (action === 'rotate') await api.projects.rotateReadonlyPassword(projectId);
      else await api.projects.dropReadonlyRole(projectId);
      await refreshConnection();
      toast.success(
        action === 'create'
          ? 'Read-only role ready'
          : action === 'rotate'
            ? 'Read-only password rotated'
            : 'Read-only role removed',
      );
    } catch (err: any) {
      toast.error(err.message || 'Read-only role update failed');
    } finally {
      setReadonlyBusy(false);
    }
  }

  async function handleCreateExtraRole() {
    if (!extraRoleLabel.trim()) return;
    setCreatingExtraRole(true);
    try {
      await api.projects.createExtraRole(projectId, extraRoleLabel.trim(), extraRoleMemberOf);
      await refreshConnection();
      setShowCreateExtraRole(false);
      setExtraRoleLabel('');
      setExtraRoleMemberOf('none');
      toast.success('Database user created');
    } catch (err: any) {
      toast.error(err.message || 'Failed to create database user');
    } finally {
      setCreatingExtraRole(false);
    }
  }

  async function handleExtraRoleAction(roleId: string, action: 'rotate' | 'remove') {
    if (action === 'remove') {
      const ok = await confirmDialog({
        title: 'Remove database user',
        description: 'Applications connecting with this role will lose access immediately.',
        destructive: true,
      });
      if (!ok) return;
    }
    setExtraRoleBusy((prev) => ({ ...prev, [roleId]: true }));
    try {
      if (action === 'rotate') {
        await api.projects.rotateExtraRolePassword(projectId, roleId);
        await refreshConnection();
        toast.success('Password rotated');
      } else {
        await api.projects.dropExtraRole(projectId, roleId);
        await refreshConnection();
        toast.success('Database user removed');
      }
    } catch (err: any) {
      toast.error(err.message || 'Operation failed');
    } finally {
      setExtraRoleBusy((prev) => ({ ...prev, [roleId]: false }));
    }
  }

  async function handleConnectionLimit(value: string) {
    setLimitBusy(true);
    try {
      await api.projects.setDbConnectionLimit(projectId, value === 'default' ? null : Number(value));
      await refreshConnection();
      toast.success(value === 'default' ? 'Pooler limit reset to the plan default' : `Pooler limit set to ${value}`);
    } catch (err: any) {
      toast.error(err.message || 'Could not update the pooler limit');
    } finally {
      setLimitBusy(false);
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
              Copy your project variables in ENV or JSON format. In ENV mode each
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
              <SelectTrigger aria-label="Framework">
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
                onClick={() => void copyEditorContent()}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy {rawEditorFormat.toUpperCase()}
              </Button>
            </div>
            <pre className="max-h-[420px] overflow-auto px-4 py-3">
              <code className="whitespace-pre text-sm text-emerald-400">
                {shownEditorContent}
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
                    Copy into your AI assistant. Wraps the ENV block above with placeholders
                    instead of the database password and the service key, plus instructions on
                    auth via basefyio-js, migrations, REST/fetch fallback, CORS/CSP, and safe
                    handling of secrets.
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
              This text never includes the database password or the service key; fill them
              in from Copy ENV in your own .env file, not in the assistant.
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
            <li><strong>Terminal:</strong> <code className="rounded bg-blue-100 dark:bg-blue-900 px-1 text-xs">psql &quot;{maskUri(conn.poolerUri)}&quot;</code></li>
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
        <SecretCopyBlock
          label="Pooler Connection URI"
          value={secrets ? rewriteLocalhostInPgUri(secrets.poolerUri, replacementHost) : null}
          masked={maskUri(conn.poolerUri)}
          icon={Link2}
          canReveal={canReveal}
          onReveal={async () => {
            const v = await ensureSecrets();
            return v ? rewriteLocalhostInPgUri(v.poolerUri, replacementHost) : null;
          }}
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
          <SecretCopyBlock
            label="Password"
            value={secrets?.password}
            masked={MASK}
            icon={Key}
            canReveal={canReveal}
            onReveal={async () => (await ensureSecrets())?.password ?? null}
          />
          <CopyBlock label="Project ID" value={projectId} icon={Database} />
        </div>
        {!canReveal && (
          <p className="text-xs text-muted-foreground">
            The password is hidden. A team owner or admin, or a role with the database password
            permission, can reveal it; each reveal is recorded in the project&apos;s activity log.
          </p>
        )}
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
          <DialogContent aria-describedby={undefined} className="max-w-md">
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
                <li>Minimum 8 characters</li>
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
        <CodeExample label="Drizzle" language="typescript" code={drizzleExample} />
        <CodeExample label="TypeORM" language="typescript" code={typeormExample} />
        <CodeExample label="SQLAlchemy" language="python" code={sqlalchemyExample} />
      </section>

      {/* Read-only access */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Shield className="h-5 w-5" />
          Read-only access
        </h2>
        <p className="text-sm text-muted-foreground">
          A second login role, <code className="rounded bg-muted px-1">{conn.readonly?.user ?? `${conn.user}_readonly`}</code>,
          for reporting and BI tools. It can SELECT from every table — including rows protected by row-level
          security, exactly like the owner — and cannot write data, change the schema or manage roles.
        </p>
        {conn.readonly ? (
          <>
            <SecretCopyBlock
              label="Read-only Pooler URI"
              value={secrets?.readonly?.poolerUri}
              masked={maskUri(conn.readonly.poolerUri)}
              icon={Link2}
              canReveal={canReveal}
              onReveal={async () => (await ensureSecrets())?.readonly?.poolerUri ?? null}
            />
            <div className="basefyio-grid-row-hover grid gap-3 sm:grid-cols-2">
              <CopyBlock label="Read-only User" value={conn.readonly.user} icon={Database} />
              <SecretCopyBlock
                label="Read-only Password"
                value={secrets?.readonly?.password}
                masked={MASK}
                icon={Key}
                canReveal={canReveal}
                onReveal={async () => (await ensureSecrets())?.readonly?.password ?? null}
              />
            </div>
            {conn.canResetDbPassword && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="gap-2" disabled={readonlyBusy} onClick={() => handleReadonlyRole('rotate')}>
                  <RefreshCw className="h-4 w-4" />
                  Rotate read-only password
                </Button>
                <Button variant="outline" disabled={readonlyBusy} onClick={() => handleReadonlyRole('create')}>
                  Repair grants
                </Button>
                <Button variant="ghost" className="text-destructive" disabled={readonlyBusy} onClick={() => handleReadonlyRole('remove')}>
                  Remove read-only role
                </Button>
              </div>
            )}
          </>
        ) : conn.canResetDbPassword ? (
          <Button variant="outline" className="gap-2" disabled={readonlyBusy} onClick={() => handleReadonlyRole('create')}>
            <Shield className="h-4 w-4" />
            {readonlyBusy ? 'Creating…' : 'Create read-only role'}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not set up yet. A team owner, or a member with the database password permission, can create it.
          </p>
        )}
      </section>

      {/* Extra database users */}
      {conn.canResetDbPassword && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Users className="h-5 w-5" />
            Extra database users
          </h2>
          <p className="text-sm text-muted-foreground">
            Named login roles for individual services or workers. Each role can be a member of{' '}
            <code className="rounded bg-muted px-1">anon</code>,{' '}
            <code className="rounded bg-muted px-1">authenticated</code> or{' '}
            <code className="rounded bg-muted px-1">service_role</code> with{' '}
            <code className="rounded bg-muted px-1">INHERIT FALSE, SET TRUE</code> — the caller
            must issue <code className="rounded bg-muted px-1">SET LOCAL ROLE</code> explicitly.
          </p>

          {(conn.extraRoles ?? []).map((role) => (
            <div key={role.id} className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-medium text-sm">{role.label}</p>
                  <p className="text-xs text-muted-foreground font-mono">{role.user}</p>
                </div>
                {role.memberOf !== 'none' && (
                  <span className="rounded-full border bg-muted px-2 py-0.5 text-xs font-mono">
                    {role.memberOf}
                  </span>
                )}
              </div>
              <SecretCopyBlock
                label="Pooler URI"
                value={secrets?.extraRoles.find((r) => r.id === role.id)?.poolerUri}
                masked={maskUri(role.poolerUri)}
                icon={Link2}
                canReveal={canReveal}
                onReveal={async () =>
                  (await ensureSecrets())?.extraRoles.find((r) => r.id === role.id)?.poolerUri ?? null
                }
              />
              <div className="basefyio-grid-row-hover grid gap-3 sm:grid-cols-2">
                <CopyBlock label="User" value={role.user} icon={Database} />
                <SecretCopyBlock
                  label="Password"
                  value={secrets?.extraRoles.find((r) => r.id === role.id)?.password}
                  masked={MASK}
                  icon={Key}
                  canReveal={canReveal}
                  onReveal={async () =>
                    (await ensureSecrets())?.extraRoles.find((r) => r.id === role.id)?.password ?? null
                  }
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="gap-2"
                  disabled={extraRoleBusy[role.id]}
                  onClick={() => void handleExtraRoleAction(role.id, 'rotate')}
                >
                  <RefreshCw className="h-4 w-4" />
                  Rotate password
                </Button>
                <Button
                  variant="ghost"
                  className="text-destructive"
                  disabled={extraRoleBusy[role.id]}
                  onClick={() => void handleExtraRoleAction(role.id, 'remove')}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}

          {showCreateExtraRole ? (
            <div className="rounded-lg border bg-card p-4 space-y-3">
              <p className="text-sm font-medium">New database user</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor="extra-role-label">Label</label>
                  <Input
                    id="extra-role-label"
                    placeholder="e.g. Academy Worker"
                    value={extraRoleLabel}
                    onChange={(e) => setExtraRoleLabel(e.target.value)}
                    maxLength={80}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor="extra-role-member-of">Member of</label>
                  <Select value={extraRoleMemberOf} onValueChange={setExtraRoleMemberOf}>
                    <SelectTrigger id="extra-role-member-of" aria-label="Member of">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None (direct grants only)</SelectItem>
                      <SelectItem value="anon">anon — public requests</SelectItem>
                      <SelectItem value="authenticated">authenticated — signed-in users</SelectItem>
                      <SelectItem value="service_role">service_role — backend workers</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={creatingExtraRole || !extraRoleLabel.trim()}
                  onClick={() => void handleCreateExtraRole()}
                >
                  {creatingExtraRole ? 'Creating…' : 'Create'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => { setShowCreateExtraRole(false); setExtraRoleLabel(''); setExtraRoleMemberOf('none'); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              className="gap-2"
              disabled={(conn.extraRoles?.length ?? 0) >= 10}
              onClick={() => setShowCreateExtraRole(true)}
            >
              <UserPlus className="h-4 w-4" />
              Add database user
            </Button>
          )}
        </section>
      )}

      {/* Pooler connection limit */}
      {conn.pooler && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Layers className="h-5 w-5" />
            Pooler connection limit
          </h2>
          <p className="text-sm text-muted-foreground">
            How many server connections this database may hold through the pooler
            {conn.pooler.effective === null
              ? ' — currently only the pooler defaults apply'
              : ` — currently ${conn.pooler.effective} (${
                  conn.pooler.source === 'project'
                    ? 'set for this project'
                    : conn.pooler.source === 'plan'
                      ? 'from your plan'
                      : 'platform default'
                })`}
            . Your plan allows up to {conn.pooler.planCeiling}.
          </p>
          {conn.canResetDbPassword && (
            <Select
              value={
                conn.pooler.source === 'project' && conn.pooler.effective !== null
                  ? String(conn.pooler.effective)
                  : 'default'
              }
              onValueChange={(v) => void handleConnectionLimit(v)}
              disabled={limitBusy}
            >
              <SelectTrigger aria-label="Connection limit" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Plan default</SelectItem>
                {[5, 10, 20, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)} disabled={n > conn.pooler!.planCeiling}>
                    {n} connections{n > conn.pooler!.planCeiling ? ' (upgrade plan)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </section>
      )}

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
          above). You do not run a separate auth server in your own repo for normal integration.
        </p>
        <button
          type="button"
          onClick={() => setShowKeycloakDetails((open) => !open)}
          className="flex w-full items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted/50"
          aria-expanded={showKeycloakDetails}
        >
          <span className="min-w-0">
            Auth realm and URL <span className="font-normal text-muted-foreground">(optional)</span>
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
              label="Auth Realm"
              value={conn.keycloakRealm}
              icon={Shield}
            />
            <CopyBlock
              label="Auth URL"
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
        <ApiKeysPanel
          projectId={projectId}
          // A rotated key changes the .env block and the snippets above: load them again.
          onKeysChanged={() => {
            api.projects
              .connect(projectId)
              .then(setConn)
              .catch((err) => toast.error(err.message));
          }}
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

      {/* Direct connection: only shown when it really is a different endpoint from the pooler */}
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-muted-foreground">
          <Database className="h-5 w-5" />
          {conn.uri !== conn.poolerUri ? 'Direct connection (no pooler)' : 'Session features'}
        </h2>
        {conn.uri !== conn.poolerUri ? (
          <>
            <p className="text-sm text-muted-foreground">
              Straight to Postgres, without the pooler. Use it for tools that need a session:
              migrations, LISTEN/NOTIFY, session-level prepared statements.
            </p>
            <CopyBlock label="Direct URI" value={conn.uri} icon={Link2} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Every connection to this database goes through the pooler, which runs in transaction mode.
            A direct, unpooled endpoint is not published, so features that need one session across
            statements (LISTEN/NOTIFY, session-level prepared statements, advisory locks) are not
            available. Use Realtime for change notifications and the SQL editor for schema changes.
          </p>
        )}
      </section>
      </>
      )}
    </div>
  );
}
