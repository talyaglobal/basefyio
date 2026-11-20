/**
 * Every controller in the tree is classified for platform API tokens (`bf_pat_…`), so a new
 * controller cannot ship without someone deciding whether a token may reach it.
 *
 *  token        — JwtOrPlatformTokenGuard on every session route; each handler names its
 *                 @Scopes (GET → `:read`, other verbs → `:write`/`:run`) or is @JwtOnly().
 *  mixed        — some handlers take tokens (same rules), the rest stay on JwtAuthGuard or a
 *                 project key.
 *  jwt-only     — JwtAuthGuard only: a token gets 403 (identity, money, operator console, …).
 *  project-key  — JwtOrApiKeyGuard: a dashboard session or a project key; a token gets 403.
 *  no-session   — public, project-key, webhook or own-credential routes; no account session.
 *
 * Reads controller source as text, like docs/route-inventory.ts, so no controller is bootstrapped.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from '../../docs/route-inventory';
import { ALL_SCOPES } from './api-tokens.constants';

type Policy = 'token' | 'mixed' | 'jwt-only' | 'project-key' | 'no-session';

/** Path under src/ → policy and the reason for it. */
export const CONTROLLER_POLICY: Record<string, [Policy, string]> = {
  // ── Token-enabled management API ──────────────────────────────────────────
  'modules/projects/projects.controller.ts': ['token', 'project lifecycle; move-to-team and the cluster base backup are @JwtOnly'],
  'modules/projects/project-database.controller.ts': ['token', 'indexes, triggers, functions, extensions (schema:*)'],
  'modules/projects/project-policies.controller.ts': ['token', 'RLS policies (schema:*)'],
  'modules/projects/project-api-keys.controller.ts': ['token', 'project keys (secrets:*)'],
  'modules/storage/s3-keys.controller.ts': ['token', 'project S3 access keys are credentials (secrets:*), never storage:*'],
  'modules/projects/folders-tags.controller.ts': ['token', 'project folders and tags (settings:*)'],
  'modules/projects/backups/project-backups.controller.ts': ['token', 'backup health; operator reconcile is @JwtOnly'],
  'modules/projects/branches/project-branches.controller.ts': ['token', 'preview branches (projects:*)'],
  'modules/teams/teams.controller.ts': ['token', 'roster and invites; create/delete/leave/ownership/security/role-permissions/invite answers are @JwtOnly'],
  'modules/integrations/integrations.controller.ts': ['token', 'project GitHub/Vercel links (integrations:*)'],
  'modules/team-integrations/team-integrations.controller.ts': ['token', 'team GitHub/Vercel connections; OAuth callbacks are unguarded'],
  'modules/migrations/migration.controller.ts': ['token', 'blueprint migrations (blueprints:*)'],
  'modules/blueprint/blueprint.controller.ts': ['token', 'Sheet to App blueprints (blueprints:*)'],
  'modules/data-import/data-import.controller.ts': ['token', 'CSV/JSON imports into a project (data:*)'],
  'modules/tenant-embedding/tenant-embedding.controller.ts': ['token', 'project embeddings setup (embeddings:*)'],
  'modules/tenant-embedding/ai-disclosure.controller.ts': ['token', 'what AI sees of a project (settings:read)'],
  'modules/notifications/notifications.controller.ts': ['token', 'your notifications (account:*)'],
  'modules/billing/billing.controller.ts': ['mixed', 'billing reads take billing:read; every payment, plan or account change needs a dashboard session'],
  'modules/feedback/feedback.controller.ts': ['mixed', 'triage reads, comments and status take feedback:*; edits and deletes need a session'],
  'modules/realtime-data/realtime-data.controller.ts': ['mixed', 'binding management takes realtime:*; the stream and broadcast take a project key'],

  // ── Dashboard session only ───────────────────────────────────────────────
  'modules/api-tokens/api-tokens.controller.ts': ['jwt-only', 'a token must never mint, list, roll or revoke tokens'],
  'modules/auth/auth.controller.ts': ['jwt-only', 'identity: profile, MFA, sessions, password, account deletion'],
  'modules/organizations/organizations.controller.ts': ['jwt-only', 'organization structure, switching and ownership'],
  'modules/root-console/root-console.controller.ts': ['jwt-only', 'platform operator console'],
  'modules/capacity/capacity.controller.ts': ['jwt-only', 'platform operator console'],
  'modules/management/management.controller.ts': ['jwt-only', 'platform operator console'],
  'modules/quickbooks/quickbooks.controller.ts': ['jwt-only', 'platform operator accounting'],
  'modules/marketing-agency/marketing-agency.controller.ts': ['jwt-only', 'platform operator marketing'],
  'modules/marketing-insights/marketing-insights.controller.ts': ['jwt-only', 'platform operator marketing'],
  'modules/observability/observability.controller.ts': ['jwt-only', 'platform operator alerts and audit log'],
  'modules/platform-status/platform-status.controller.ts': ['jwt-only', 'status page administration; public routes need no credential'],
  'modules/features/features.controller.ts': ['jwt-only', 'dashboard feature flags and their operator management'],
  'modules/ai/ai.controller.ts': ['jwt-only', 'dashboard assistant (paid model calls)'],
  'modules/ai-chat/ai-chat.controller.ts': ['jwt-only', 'dashboard assistant (paid model calls)'],
  'modules/recommendation/recommendation.controller.ts': ['jwt-only', 'dashboard editor suggestions'],
  'modules/search/search.controller.ts': ['jwt-only', 'dashboard global search'],
  'modules/realtime/realtime.controller.ts': ['jwt-only', 'dashboard event stream'],

  // ── Session or project key (data plane) ──────────────────────────────────
  'modules/agent/agent-creation.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/agent/agent.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/data-engine/data-engine.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/data-query/data-query.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/data-structures/data-structures.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/flows/flows.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/projects/collection.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/projects/project-auth.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/projects/project-data.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/provisioning/provisioning.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/rag/rag.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/sql/sql.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/storage-facade/storage-catalog.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/storage/storage-policy.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/storage/storage.controller.ts': ['project-key', 'data plane: use the project key'],
  'modules/storage/upload-session.controller.ts': ['project-key', 'data plane: use the project key'],

  // ── No account session at all ────────────────────────────────────────────
  'codefyio/codefyio.controller.ts': ['no-session', 'Codefyio adapter session'],
  'modules/flows/flow-webhook.controller.ts': ['no-session', 'inbound webhook'],
  'modules/health/health.controller.ts': ['no-session', 'public probe'],
  'modules/health/metrics.controller.ts': ['no-session', 'metrics scrape'],
  'modules/integrations/tsmart/tsmart-integration.controller.ts': ['no-session', 'partner credential'],
  'modules/mcp/mcp.controller.ts': ['no-session', 'MCP: takes tokens only and checks scope + team per tool itself'],
  'modules/projects/project-oauth-callback.controller.ts': ['no-session', 'OAuth callback'],
  'modules/projects/project-sdk-auth.controller.ts': ['no-session', 'project key (end-user auth)'],
  'modules/projects/public-api.controller.ts': ['no-session', 'project key (REST data plane)'],
  'modules/projects/public-collection-api.controller.ts': ['no-session', 'project key (collections data plane)'],
  'modules/projects/supabase-auth-compat.controller.ts': ['no-session', 'project key (auth/v1)'],
  'modules/projects/supabase-auth-open.controller.ts': ['no-session', 'public auth/v1 route'],
  'modules/storage-facade/storage-v1-public.controller.ts': ['no-session', 'public storage objects'],
  'modules/storage-facade/storage-v1.controller.ts': ['no-session', 'project key (storage/v1)'],
  'modules/tenant-embedding/tenant-embedding-public.controller.ts': ['no-session', 'project key (embeddings)'],
};

const SRC = path.resolve(__dirname, '../..');
const METHOD_RE = /^@(Get|Post|Put|Patch|Delete|Head|Options|All)\(/;

export interface HandlerInfo {
  verb: string;
  decorators: string[];
  classGuards: string;
}

/** Splits a controller file into handlers with their decorators and the owning class's guards. */
export function parseHandlers(source: string): HandlerInfo[] {
  const text = stripComments(source);
  const lines = text.split('\n');
  const handlers: HandlerInfo[] = [];
  let classGuards = '';
  let classDecorators: string[] = [];
  let pending: string[] = [];
  let current = '';
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (current) {
      current += ' ' + line;
      depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      if (depth <= 0) {
        pending.push(current);
        current = '';
      }
      continue;
    }
    if (line.startsWith('@')) {
      depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      if (depth > 0) current = line;
      else pending.push(line);
      continue;
    }
    if (!line) continue;
    if (/^export class /.test(line) || /^class /.test(line)) {
      classDecorators = pending;
      classGuards = classDecorators.filter((d) => d.startsWith('@UseGuards')).join(' ');
      pending = [];
      continue;
    }
    const method = pending.find((d) => METHOD_RE.test(d));
    if (method) {
      handlers.push({ verb: method.match(METHOD_RE)![1].toUpperCase(), decorators: pending, classGuards });
    }
    pending = [];
  }
  return handlers;
}

const guardsOf = (h: HandlerInfo) => `${h.classGuards} ${h.decorators.filter((d) => d.startsWith('@UseGuards')).join(' ')}`;
const takesTokens = (h: HandlerInfo) => /\bJwtOrPlatformTokenGuard\b/.test(guardsOf(h));
const scopesOf = (h: HandlerInfo): string[] | null => {
  const d = h.decorators.find((x) => x.startsWith('@Scopes('));
  if (!d) return null;
  return [...d.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};
const isJwtOnly = (h: HandlerInfo) => h.decorators.some((d) => d.startsWith('@JwtOnly('));

function controllerFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.controller.ts')) out.push(path.relative(SRC, full).split(path.sep).join('/'));
    }
  };
  walk(SRC);
  return out.sort();
}

describe('platform API token route policy', () => {
  const files = controllerFiles();

  it('classifies every controller in the tree', () => {
    const unclassified = files.filter((f) => !CONTROLLER_POLICY[f]);
    expect(unclassified).toEqual([]);
    const stale = Object.keys(CONTROLLER_POLICY).filter((f) => !files.includes(f));
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(CONTROLLER_POLICY))('%s matches its policy', (file, [policy]) => {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    const handlers = parseHandlers(source);
    expect(handlers.length).toBeGreaterThan(0);
    const tokenHandlers = handlers.filter(takesTokens);
    const problems: string[] = [];

    for (const h of handlers) {
      const scopes = scopesOf(h);
      const label = `${h.verb} ${h.decorators.find((d) => METHOD_RE.test(d))}`;
      if (!takesTokens(h)) {
        if (scopes || isJwtOnly(h)) problems.push(`${label}: @Scopes/@JwtOnly without JwtOrPlatformTokenGuard`);
        continue;
      }
      if (!scopes && !isJwtOnly(h)) problems.push(`${label}: takes tokens but declares no @Scopes or @JwtOnly`);
      if (scopes && isJwtOnly(h)) problems.push(`${label}: both @Scopes and @JwtOnly`);
      for (const s of scopes ?? []) {
        if (!ALL_SCOPES.has(s)) problems.push(`${label}: unknown scope ${s}`);
        if (h.verb === 'GET' && !s.endsWith(':read')) problems.push(`${label}: GET must need a :read scope, has ${s}`);
        if (h.verb !== 'GET' && s.endsWith(':read')) problems.push(`${label}: ${h.verb} must need a write scope, has ${s}`);
      }
    }

    const usesJwtOnlyGuard = /\bJwtAuthGuard\b/.test(source.replace(/import[^;]*;/g, ''));
    const usesProjectKey = /\bJwtOrApiKeyGuard\b/.test(source.replace(/import[^;]*;/g, ''));
    switch (policy) {
      case 'token':
        if (tokenHandlers.length === 0) problems.push('no handler takes tokens');
        if (usesJwtOnlyGuard) problems.push('uses JwtAuthGuard; mark session-only handlers @JwtOnly() instead');
        break;
      case 'mixed':
        if (tokenHandlers.length === 0) problems.push('no handler takes tokens');
        if (tokenHandlers.length === handlers.length) problems.push('every handler takes tokens; classify as token');
        break;
      case 'jwt-only':
        if (tokenHandlers.length > 0) problems.push('a handler takes tokens');
        if (!usesJwtOnlyGuard) problems.push('does not use JwtAuthGuard');
        break;
      case 'project-key':
        if (tokenHandlers.length > 0) problems.push('a handler takes tokens');
        if (!usesProjectKey) problems.push('does not use JwtOrApiKeyGuard');
        break;
      case 'no-session':
        if (tokenHandlers.length > 0) problems.push('a handler takes tokens');
        if (usesJwtOnlyGuard || usesProjectKey) problems.push('uses a session guard; classify it');
        break;
    }
    expect(problems).toEqual([]);
  });

  it('parses decorators that sit below the method decorator', () => {
    const handlers = parseHandlers(`
@Controller('x')
export class X {
  @Get('a')
  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
  @Scopes('team:read')
  a() {}

  @Post(
    'b',
  )
  @JwtOnly()
  b() {}
}`);
    expect(handlers.map((h) => [h.verb, takesTokens(h), scopesOf(h), isJwtOnly(h)])).toEqual([
      ['GET', true, ['team:read'], false],
      ['POST', false, null, true],
    ]);
  });
});
