/**
 * Workspace addresses: every team may claim one `<subdomain>.<base domain>`
 * host, which then answers that team's API and names its database host.
 *
 * Everything here is pure so the rules can be tested without a database and
 * shared word for word by the claim flow and the host resolver.
 */

/** One DNS label is at most 63 characters; three keeps out two-letter noise. */
export const SUBDOMAIN_MIN_LENGTH = 3;
export const SUBDOMAIN_MAX_LENGTH = 63;

/**
 * How long an address a team gives up keeps answering for that team — and
 * stays unavailable to everyone else — so apps still pointed at it have time
 * to move.
 */
export const SUBDOMAIN_HOLD_DAYS = 30;

/**
 * Names no team may claim. Every host the platform itself serves under the base
 * domain must be listed here: a team holding one would capture that host's
 * traffic the moment wildcard routing goes live. The rest are kept for later
 * use or because they invite impersonation (login, billing, support).
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  // Hosts the platform serves today
  'app', 'api', 'admin', 'auth', 'db', 'storage', 'traefik', 'minio', 'minio-console', 'www',
  // Product and company surfaces
  'console', 'dashboard', 'studio', 'portal', 'panel', 'platform', 'cloud', 'home', 'docs',
  'doc', 'help', 'support', 'status', 'blog', 'news', 'changelog', 'community', 'forum',
  'about', 'pricing', 'billing', 'pay', 'payment', 'payments', 'invoice', 'invoices',
  'careers', 'jobs', 'legal', 'terms', 'privacy', 'security', 'trust', 'press', 'partners',
  'marketplace', 'store', 'shop', 'sales', 'contact', 'team', 'teams', 'org', 'orgs',
  'management', 'manage', 'root', 'system', 'internal', 'staff', 'ops', 'operator',
  // Sign-in and identity
  'login', 'logout', 'signin', 'signup', 'register', 'sso', 'oauth', 'oidc', 'saml',
  'account', 'accounts', 'id', 'identity', 'keycloak', 'secure', 'password', 'verify',
  // Mail and DNS
  'mail', 'email', 'emails', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'send', 'bounce',
  'bounces', 'newsletter', 'postmaster', 'hostmaster', 'webmaster', 'abuse', 'noreply',
  'no-reply', 'autoconfig', 'autodiscover', 'dmarc', 'dkim', 'spf', 'ns', 'ns1', 'ns2',
  'ns3', 'ns4', 'dns',
  // Network and infrastructure
  'ftp', 'sftp', 'ssh', 'vpn', 'proxy', 'gateway', 'lb', 'edge', 'cdn', 'static', 'assets',
  'media', 'img', 'images', 'files', 'file', 'upload', 'uploads', 'download', 'downloads',
  'git', 'registry', 'docker', 'k8s', 'kubernetes', 'ci', 'build', 'deploy', 'metrics',
  'monitoring', 'grafana', 'prometheus', 'logs', 'health', 'backup', 'backups',
  // Data and runtime surfaces
  'sql', 'json', 'postgres', 'postgresql', 'pg', 'pgbouncer', 'pooler', 'database', 'redis',
  'mongo', 'mongodb', 'couchdb', 's3', 'realtime', 'ws', 'wss', 'socket', 'graphql', 'rest',
  'rpc', 'functions', 'function', 'hooks', 'webhook', 'webhooks', 'events', 'queue', 'cron',
  'flows', 'ai', 'mcp', 'sdk', 'cli',
  // Environments
  'dev', 'development', 'staging', 'stage', 'test', 'testing', 'qa', 'demo', 'sandbox',
  'preview', 'prod', 'production', 'beta', 'alpha', 'canary', 'local', 'localhost',
]);

/** Words that may not appear anywhere in a name: they would pass for the platform itself. */
const RESERVED_FRAGMENTS = ['basefyio', 'kolaybase'];

export type SubdomainProblem =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'invalid_characters'
  | 'must_start_with_letter'
  | 'hyphen_edge'
  | 'double_hyphen'
  | 'reserved';

export type SubdomainCheck =
  | { ok: true; value: string }
  | { ok: false; value: string; code: SubdomainProblem; message: string };

/** What a person typed, the way it will be stored: trimmed and lower-cased. */
export function normalizeSubdomain(input: unknown): string {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

/**
 * Whether a name may be a workspace address. DNS-safe (one label of a-z, 0-9
 * and inner hyphens), starts with a letter so it never looks like an address
 * or a number, no `--` (which also rules out punycode `xn--` look-alikes), and
 * not reserved.
 */
export function validateSubdomain(input: unknown): SubdomainCheck {
  const value = normalizeSubdomain(input);
  const fail = (code: SubdomainProblem, message: string): SubdomainCheck => ({
    ok: false,
    value,
    code,
    message,
  });

  if (!value) return fail('empty', 'Enter an address for your workspace.');
  if (value.length < SUBDOMAIN_MIN_LENGTH) {
    return fail('too_short', `An address needs at least ${SUBDOMAIN_MIN_LENGTH} characters.`);
  }
  if (value.length > SUBDOMAIN_MAX_LENGTH) {
    return fail('too_long', `An address can be at most ${SUBDOMAIN_MAX_LENGTH} characters.`);
  }
  if (!/^[a-z0-9-]+$/.test(value)) {
    return fail('invalid_characters', 'Use only lowercase letters, digits and hyphens.');
  }
  if (!/^[a-z]/.test(value)) {
    return fail('must_start_with_letter', 'An address must start with a letter.');
  }
  if (value.endsWith('-')) {
    return fail('hyphen_edge', 'An address cannot end with a hyphen.');
  }
  if (value.includes('--')) {
    return fail('double_hyphen', 'An address cannot contain two hyphens in a row.');
  }
  if (RESERVED_SUBDOMAINS.has(value) || RESERVED_FRAGMENTS.some((w) => value.includes(w))) {
    return fail('reserved', `"${value}" is reserved. Choose another address.`);
  }
  return { ok: true, value };
}

/** A domain name the way hosts are compared: lower case, no trailing dot. */
function cleanDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
}

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * The domain workspace addresses live under. TENANT_BASE_DOMAIN when set;
 * otherwise the parent of the public API host when that host is `api.<domain>`
 * (production: api.basefyio.com → basefyio.com). Null when neither gives a
 * real domain — local development on localhost, an IP address — and then no
 * host is ever treated as a workspace address.
 */
export function resolveBaseDomain(explicit?: string | null, publicApiUrl?: string | null): string | null {
  if (explicit && explicit.trim()) {
    const d = cleanDomain(explicit);
    return DOMAIN_RE.test(d) ? d : null;
  }
  if (!publicApiUrl) return null;
  let host: string;
  try {
    host = new URL(publicApiUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const labels = host.split('.');
  if (labels.length < 3 || labels[0] !== 'api') return null;
  const parent = labels.slice(1).join('.');
  return DOMAIN_RE.test(parent) ? parent : null;
}

/** The Host header without its port: `Example.com:443` → `example.com`, `[::1]:80` → `::1`. */
export function hostWithoutPort(hostHeader: string | undefined | null): string {
  if (!hostHeader) return '';
  const raw = String(hostHeader).trim().toLowerCase();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end > 0 ? raw.slice(1, end) : raw;
  }
  const colon = raw.indexOf(':');
  // More than one colon and no brackets: a bare IPv6 address, keep it whole.
  if (colon >= 0 && raw.indexOf(':', colon + 1) === -1) return raw.slice(0, colon).replace(/\.+$/, '');
  return raw.replace(/\.+$/, '');
}

export type HostClassification =
  /** Not a workspace address — the request is handled exactly as before. */
  | { kind: 'platform' }
  /** `<label>.<base domain>` with a label a team could hold. */
  | { kind: 'workspace'; label: string; host: string };

/**
 * Sort a request host into the platform's own hosts and workspace addresses.
 *
 * Only a single label directly under the base domain can be a workspace. The
 * base domain itself, reserved labels (app, api, db, storage, …), deeper names
 * and every other host are 'platform', so the hosts that work today keep
 * working untouched. A label no team could ever claim (bad characters) is
 * still a 'workspace' — it simply never resolves.
 */
export function classifyHost(hostHeader: string | undefined | null, baseDomain: string | null): HostClassification {
  if (!baseDomain) return { kind: 'platform' };
  const host = hostWithoutPort(hostHeader);
  if (!host || host === baseDomain) return { kind: 'platform' };
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return { kind: 'platform' };
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes('.')) return { kind: 'platform' };
  if (RESERVED_SUBDOMAINS.has(label)) return { kind: 'platform' };
  return { kind: 'workspace', label, host };
}

/** `technoplatz` + `basefyio.com` → `technoplatz.basefyio.com`. */
export function workspaceHost(subdomain: string, baseDomain: string): string {
  return `${subdomain}.${baseDomain}`;
}

/** The URL an SDK or HTTP client is given: the SDK appends `/api` itself. */
export function workspaceApiUrl(subdomain: string, baseDomain: string): string {
  return `https://${workspaceHost(subdomain, baseDomain)}`;
}
