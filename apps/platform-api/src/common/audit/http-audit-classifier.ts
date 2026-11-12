/**
 * Turns one HTTP request into an audit record that says what happened.
 *
 * The interceptor used to write a raw access line: severity was LOW for every
 * success and HIGH for every failure (a 404 GET included), the resource type
 * was the first path segment ("projects" for a bucket, a branch or a token),
 * and there was no way to tell a permanent project deletion from a rename.
 * This module is pure so the rules can be read and tested in one place.
 */

export type AuditSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface HttpAuditInput {
  method: string;
  /** Concrete path without the query string, e.g. `/api/projects/abc/permanent`. */
  path: string;
  /** Express route pattern when the request matched one, e.g. `/api/projects/:id/permanent`. */
  routePattern?: string | null;
  params?: Record<string, unknown> | null;
  statusCode: number;
  success: boolean;
  /** The request body, used only for the names (and a few safe values) of the fields changed. */
  body?: unknown;
  /** The handler's result, used only to pick up the id of a created resource. */
  responseBody?: unknown;
}

export interface HttpAuditDescription {
  /** Domain event name such as `project.deleted.permanent`, or null for routine traffic. */
  event: string | null;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  severity: AuditSeverity;
  /** Names of the request body fields, so two PATCHes to the same URL can be told apart. */
  fields?: string[];
  /** Values of a short allow-list of non-secret fields (name, visibility, role…). */
  changes?: Record<string, unknown>;
}

interface DomainRule {
  method: string;
  /** Matched against the concrete path, with `[^/]+` standing in for ids. */
  pattern: RegExp;
  event: string;
  resourceType: string;
  /** Severity when the request succeeded. */
  severity: AuditSeverity;
}

const ID = '[^/]+';
const rule = (
  method: string,
  path: string,
  event: string,
  resourceType: string,
  severity: AuditSeverity,
): DomainRule => ({
  method,
  pattern: new RegExp(`^/api${path.replace(/:id/g, ID)}/?$`),
  event,
  resourceType,
  severity,
});

/**
 * Actions that matter to a security review, named after what they do. Order
 * matters: the first match wins, so the specific paths come before the general.
 */
export const DOMAIN_RULES: DomainRule[] = [
  // Projects
  rule('DELETE', '/projects/:id/permanent', 'project.deleted.permanent', 'project', 'CRITICAL'),
  rule('DELETE', '/projects/:id', 'project.trashed', 'project', 'HIGH'),
  rule('POST', '/projects/:id/restore', 'project.restored', 'project', 'MEDIUM'),
  rule('POST', '/projects/:id/deactivate', 'project.deactivated', 'project', 'HIGH'),
  rule('POST', '/projects/:id/reactivate', 'project.reactivated', 'project', 'MEDIUM'),
  rule('POST', '/projects/:id/move-to-team', 'project.moved', 'project', 'HIGH'),
  rule('PATCH', '/projects/:id/db-password', 'project.db_password.changed', 'project', 'HIGH'),
  rule('GET', '/projects/:id/connect', 'project.credentials.read', 'project', 'MEDIUM'),
  rule('PATCH', '/projects/:id', 'project.updated', 'project', 'MEDIUM'),
  rule('POST', '/projects', 'project.created', 'project', 'MEDIUM'),
  rule('POST', '/projects/:id/backups/restore', 'project.backup.restored', 'project', 'HIGH'),
  rule('POST', '/projects/:id/pitr/restore', 'project.pitr.restored', 'project', 'HIGH'),
  rule('POST', '/projects/:id/export', 'project.exported', 'project', 'MEDIUM'),

  // Platform API tokens
  rule('POST', '/account/api-tokens', 'api_token.created', 'api_token', 'HIGH'),
  rule('POST', '/account/api-tokens/:id/roll', 'api_token.rolled', 'api_token', 'HIGH'),
  rule('PATCH', '/account/api-tokens/:id', 'api_token.updated', 'api_token', 'HIGH'),
  rule('DELETE', '/account/api-tokens/:id/permanent', 'api_token.deleted', 'api_token', 'MEDIUM'),
  rule('DELETE', '/account/api-tokens/:id', 'api_token.revoked', 'api_token', 'HIGH'),

  // Teams
  rule('DELETE', '/teams/:id', 'team.deleted', 'team', 'CRITICAL'),
  rule('POST', '/teams/:id/transfer-ownership', 'team.ownership.transferred', 'team', 'CRITICAL'),
  rule('PATCH', '/teams/:id/members/:id/role', 'team.member.role_changed', 'team_member', 'HIGH'),
  rule('DELETE', '/teams/:id/members/:id', 'team.member.removed', 'team_member', 'HIGH'),
  rule('PUT', '/teams/:id/role-permissions/:id', 'team.role_permissions.changed', 'team', 'HIGH'),
  rule('POST', '/teams/:id/invites', 'team.invite.created', 'team_invite', 'MEDIUM'),

  // Project authentication settings
  rule('PUT', '/projects/:id/auth/config', 'auth.config.updated', 'auth_config', 'HIGH'),
  rule('PUT', '/projects/:id/auth/policies', 'auth.password_policy.updated', 'auth_policy', 'HIGH'),
  rule('PUT', '/projects/:id/auth/providers/:id', 'auth.provider.updated', 'auth_provider', 'HIGH'),
  rule('DELETE', '/projects/:id/auth/users/:id', 'auth.user.deleted', 'auth_user', 'HIGH'),

  // Storage
  rule('POST', '/projects/:id/storage/buckets', 'storage.bucket.created', 'storage_bucket', 'MEDIUM'),
  rule('PATCH', '/projects/:id/storage/buckets/:id', 'storage.bucket.updated', 'storage_bucket', 'HIGH'),
  rule('DELETE', '/projects/:id/storage/buckets/:id', 'storage.bucket.deleted', 'storage_bucket', 'HIGH'),

  // Database
  rule('PUT', '/projects/:id/database/extensions', 'database.extensions.changed', 'database_extension', 'HIGH'),
  rule('POST', '/projects/:id/database/extensions/defaults', 'database.extensions.changed', 'database_extension', 'HIGH'),

  // Preview branches
  rule('POST', '/projects/:id/branches', 'branch.created', 'branch', 'MEDIUM'),
  rule('DELETE', '/projects/:id/branches/:id', 'branch.deleted', 'branch', 'HIGH'),
];

/**
 * Static path segments that name an operation rather than a resource. They are
 * skipped when working out which resource a request was about.
 */
const VERBS = new Set([
  'permanent', 'roll', 'restore', 'deactivate', 'reactivate', 'activate', 'revoke', 'rotate',
  'reveal', 'accept', 'decline', 'reinvite', 'toggle', 'defaults', 'repair', 'purge', 'logout',
  'send-recovery', 'send-verification', 'require-mfa', 'reset-password', 'transfer-ownership',
  'read', 'test', 'run', 'exists', 'move', 'copy', 'sync', 'export', 'import', 'start', 'stop',
  'pause', 'resume', 'retry', 'cancel', 'enable', 'disable', 'verify', 'preview', 'regenerate',
  'refresh', 'status', 'events', 'download', 'diagnose', 'validate', 'move-to-team',
]);

/** Prefixes that say which API surface a path belongs to, not which resource. */
const SURFACE = new Set(['api', 'v1', 'rest']);

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const looksLikeId = (seg: string) => UUIDISH.test(seg) || /^\d+$/.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg);

/** Fields whose values are safe and useful in an audit trail. Everything else is recorded by name only. */
const SAFE_VALUE_FIELDS = new Set([
  'name', 'description', 'folderId', 'tags', 'public', 'isPublic', 'visibility', 'role', 'status',
  'scopes', 'expiresAt', 'enabled', 'plan', 'planId', 'teamId', 'targetTeamId', 'reasonCode',
  'reasonLabel', 'extensions', 'allowedMimeTypes', 'fileSizeLimit', 'provider', 'region',
]);

/** Field names that must never have their value recorded, even if they look harmless. */
const SECRET_FIELD = /pass|secret|token|credential|authorization|cookie|signature|otp/i;

function describeBody(body: unknown): { fields?: string[]; changes?: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const keys = Object.keys(body as Record<string, unknown>).slice(0, 40);
  if (keys.length === 0) return {};
  const changes: Record<string, unknown> = {};
  for (const k of keys) {
    if (!SAFE_VALUE_FIELDS.has(k) || SECRET_FIELD.test(k)) continue;
    const v = (body as Record<string, unknown>)[k];
    if (v === null || typeof v === 'boolean' || typeof v === 'number') changes[k] = v;
    else if (typeof v === 'string') changes[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else if (Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length <= 100)) {
      changes[k] = v;
    }
  }
  return { fields: keys, ...(Object.keys(changes).length ? { changes } : {}) };
}

/**
 * The resource a request was about, from the route pattern when there is one
 * (so `:bucketName` is known to be an id) and from the shape of the path when
 * there is not.
 */
export function parseResource(
  path: string,
  routePattern?: string | null,
  params?: Record<string, unknown> | null,
): { resourceType: string; resourceId: string | null; projectId: string | null } {
  const concrete = path.split('?')[0].split('/').filter(Boolean);
  const pattern = routePattern ? routePattern.split('/').filter(Boolean) : null;
  const usePattern =
    !!pattern && pattern.length === concrete.length && !pattern.some((p) => /[*(]/.test(p));

  const entries: { noun: string; id: string | null }[] = [];
  let projectId: string | null = null;
  for (let i = 0; i < concrete.length; i++) {
    const seg = concrete[i];
    const isParam = usePattern ? pattern![i].startsWith(':') : looksLikeId(seg);
    if (isParam) {
      const value = usePattern
        ? String(params?.[pattern![i].slice(1)] ?? decodeURIComponent(seg))
        : decodeURIComponent(seg);
      const last = entries[entries.length - 1];
      if (last && last.id === null) last.id = value;
      if (last?.noun === 'projects' && !projectId) projectId = value;
      continue;
    }
    if (SURFACE.has(seg) && entries.length === 0) continue;
    if (VERBS.has(seg)) continue;
    entries.push({ noun: seg, id: null });
  }

  if (entries.length === 0) return { resourceType: 'system', resourceId: null, projectId };
  const target = entries[entries.length - 1];
  const prev = entries[entries.length - 2];
  // "auth/config", "storage/buckets": a bare noun under another bare noun reads better joined.
  const resourceType =
    target.id === null && prev && prev.id === null ? `${prev.noun}.${target.noun}` : target.noun;
  return { resourceType, resourceId: target.id, projectId };
}

/**
 * How much a security reviewer should care about this request.
 *
 * Successful reads are routine; writes matter more, deletions more still, and
 * the domain rules raise the actions that change who can reach what. A failed
 * request matters by how it failed: being refused (401/403) is a signal, a
 * not-found or a validation error mostly is not, and a server error is ours.
 */
export function classifySeverity(
  method: string,
  statusCode: number,
  success: boolean,
  ruleSeverity?: AuditSeverity | null,
): AuditSeverity {
  const write = !['GET', 'HEAD'].includes(method.toUpperCase());
  if (success) {
    if (ruleSeverity) return ruleSeverity;
    if (!write) return 'LOW';
    return method.toUpperCase() === 'DELETE' ? 'HIGH' : 'MEDIUM';
  }
  if (statusCode === 401 || statusCode === 403) return write ? 'HIGH' : 'MEDIUM';
  if (statusCode >= 500) return 'MEDIUM';
  return write ? 'MEDIUM' : 'LOW';
}

function createdId(responseBody: unknown): string | null {
  if (!responseBody || typeof responseBody !== 'object') return null;
  const r = responseBody as Record<string, unknown>;
  for (const k of ['id', 'name']) {
    if (typeof r[k] === 'string' && (r[k] as string).length > 0 && (r[k] as string).length <= 200) {
      return r[k] as string;
    }
  }
  return null;
}

export function describeHttpRequest(input: HttpAuditInput): HttpAuditDescription {
  const method = input.method.toUpperCase();
  const path = input.path.split('?')[0];
  const parsed = parseResource(path, input.routePattern, input.params);
  const domain = DOMAIN_RULES.find((r) => r.method === method && r.pattern.test(path)) ?? null;

  let resourceId = parsed.resourceId;
  if (!resourceId && method === 'POST' && input.success) resourceId = createdId(input.responseBody);
  // A project-level rule is about the project even when the path goes deeper.
  if (domain && domain.resourceType === 'project' && parsed.projectId) resourceId = parsed.projectId;

  const body = ['GET', 'HEAD', 'OPTIONS'].includes(method) ? {} : describeBody(input.body);
  return {
    event: domain?.event ?? null,
    resourceType: domain?.resourceType ?? parsed.resourceType,
    resourceId,
    projectId: parsed.projectId,
    severity: classifySeverity(method, input.statusCode, input.success, domain?.severity),
    ...body,
  };
}

/**
 * Successful reads that are still worth keeping in the database even when
 * routine reads are not: they hand out secrets or bulk data.
 */
const SENSITIVE_READS: RegExp[] = [
  /\/projects\/[^/]+\/connect$/,
  /\/credentials(\/|$)/,
  /\/secrets?(\/|$)/,
  /\/keys(\/|$)/,
  /\/export\/jobs\/[^/]+\/download$/,
  /\/backups\/[^/]+\/download$/,
  /\/auth\/export(\/|$)/,
];

export function isSensitiveRead(path: string): boolean {
  return SENSITIVE_READS.some((re) => re.test(path));
}

/**
 * Whether a request is persisted to `audit_logs`.
 *
 * `AUDIT_HTTP_READS=all` keeps every request, the old behaviour. The default
 * keeps every write and every failed request, but a successful read only when
 * it hands out secrets or data: page loads alone made up over 90% of the table
 * and buried the actions a reviewer is looking for. Every request is still
 * forwarded to the external audit sink when one is configured.
 */
export function shouldPersistHttpAudit(method: string, path: string, success: boolean): boolean {
  const mode = (process.env.AUDIT_HTTP_READS || 'writes').trim().toLowerCase();
  if (mode === 'all') return true;
  const read =
    ['GET', 'HEAD'].includes(method.toUpperCase()) ||
    // Minting an event-stream ticket changes nothing; it happens on every stream (re)connect.
    (method.toUpperCase() === 'POST' && path === '/api/auth/stream-ticket');
  if (!read || !success) return true;
  return isSensitiveRead(path);
}

/** The caller's address as the proxy saw it, then as the socket saw it. */
export function clientIp(request: any): string | null {
  const xff = request?.headers?.['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  if (typeof first === 'string' && first.trim()) return first.split(',')[0].trim().slice(0, 64);
  const real = request?.headers?.['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 64);
  const ip = request?.ip || request?.socket?.remoteAddress;
  return typeof ip === 'string' && ip ? ip.slice(0, 64) : null;
}

export function userAgent(request: any): string | null {
  const ua = request?.headers?.['user-agent'];
  return typeof ua === 'string' && ua ? ua.slice(0, 300) : null;
}

/** The HTTP status an error will be answered with, for the audit row. */
export function statusFromError(err: any): number {
  if (err && typeof err.getStatus === 'function') {
    try {
      const s = Number(err.getStatus());
      if (Number.isInteger(s) && s >= 100 && s <= 599) return s;
    } catch {
      /* fall through */
    }
  }
  const s = Number(err?.status ?? err?.statusCode);
  if (Number.isInteger(s) && s >= 100 && s <= 599) return s;
  return 500;
}
