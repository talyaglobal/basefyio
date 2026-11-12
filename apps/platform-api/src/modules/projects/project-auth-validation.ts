/**
 * Input rules for the project user directory and its auth settings, shared by
 * ProjectAuthController and ProjectAuthConfigService. Pure functions: no I/O,
 * so every rule has a spec next to it.
 *
 * The dashboard applies the same limits in the browser for inline errors; the
 * server is where they are enforced, because the routes are also reachable
 * with a service key.
 */
import { BadRequestException } from '@nestjs/common';

/** Accepted range for the minimum password length. */
export const PASSWORD_MIN_LENGTH_BOUNDS = { min: 6, max: 128 } as const;
/** Accepted range for the access-token lifetime, in seconds (5 minutes – 24 hours). */
export const TOKEN_LIFESPAN_BOUNDS = { min: 300, max: 86_400 } as const;

/** What `brute-force protection` and the password policy can be set to. */
export const POLICY_BOUNDS = {
  failureFactor: { min: 1, max: 100 },
  waitIncrementSeconds: { min: 1, max: 86_400 },
  maxFailureWaitSeconds: { min: 1, max: 86_400 },
  historyCount: { min: 0, max: 24 },
  expiryDays: { min: 0, max: 3_650 },
} as const;

/** The email providers a project can send through; null is the platform's own service. */
export const EMAIL_PROVIDERS = ['smtp', 'resend', 'sendgrid', 'ses'] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

const EMAIL_RE = /^[^\s@]+@(?:[^\s@.]+\.)+[^\s@.]{2,}$/;

/** A mailbox address with a domain and a top-level domain ("a@b" is refused). */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

/**
 * A phone number in E.164 form. Spaces, dashes, dots and brackets are dropped
 * first, so "+1 (555) 010-0100" is accepted and stored as "+15550100100".
 * Returns null for an empty value (which clears the number).
 */
export function normalizePhoneNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('Phone number must be a string in international format, e.g. +15550100100');
  }
  const compact = value.replace(/[\s().-]/g, '');
  if (compact === '') return null;
  if (!/^\+[1-9]\d{6,14}$/.test(compact)) {
    throw new BadRequestException(
      'Phone number must be in international (E.164) format: a "+", the country code and the number, e.g. +15550100100',
    );
  }
  return compact;
}

/** A trimmed display name, or null when blank. Refuses absurd lengths. */
export function normalizePersonName(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new BadRequestException(`${label} must be text`);
  const trimmed = value.trim();
  if (trimmed.length > 255) throw new BadRequestException(`${label} must be at most 255 characters`);
  return trimmed === '' ? null : trimmed;
}

function intIn(value: unknown, label: string, bounds: { min: number; max: number }): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new BadRequestException(`${label} must be a whole number`);
  }
  if (n < bounds.min || n > bounds.max) {
    throw new BadRequestException(`${label} must be between ${bounds.min} and ${bounds.max}`);
  }
  return n;
}

// ── Password policy ─────────────────────────────────────────────────────────

export interface PasswordRules {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigits: boolean;
  requireSpecial: boolean;
  historyCount: number;
  expiryDays: number;
}

/** Keycloak policy parts this dashboard edits; everything else in the string is kept as is. */
const MANAGED_POLICY_PARTS = [
  'length',
  'upperCase',
  'lowerCase',
  'digits',
  'specialChars',
  'passwordHistory',
  'forceExpiredPasswordChange',
];

/** Parse a Keycloak passwordPolicy string ("length(8) and digits(1)") into structured rules. */
export function parsePasswordPolicy(policy: string | null | undefined): PasswordRules {
  const str = policy || '';
  const num = (re: RegExp) => {
    const m = re.exec(str);
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    minLength: num(/(?:^|\s)length\((\d+)\)/),
    requireUppercase: /upperCase\(/.test(str),
    requireLowercase: /lowerCase\(/.test(str),
    requireDigits: /digits\(/.test(str),
    requireSpecial: /specialChars\(/.test(str),
    historyCount: num(/passwordHistory\((\d+)\)/),
    expiryDays: num(/forceExpiredPasswordChange\((\d+)\)/),
  };
}

/**
 * Write structured rules into a Keycloak policy string, replacing only the
 * parts the dashboard manages. Parts it does not know about (notUsername,
 * maxLength, regexPattern…) survive untouched, so saving the form never
 * strips a rule someone set directly in Keycloak.
 */
export function mergePasswordPolicy(existing: string | null | undefined, rules: Partial<PasswordRules>): string {
  const kept = (existing || '')
    .split(/\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((part) => {
      const name = part.replace(/\(.*$/, '');
      return !MANAGED_POLICY_PARTS.includes(name);
    });
  const current = parsePasswordPolicy(existing);
  const next: PasswordRules = { ...current, ...rules } as PasswordRules;
  const managed: string[] = [];
  if (next.minLength && next.minLength > 0) managed.push(`length(${next.minLength})`);
  if (next.requireUppercase) managed.push('upperCase(1)');
  if (next.requireLowercase) managed.push('lowerCase(1)');
  if (next.requireDigits) managed.push('digits(1)');
  if (next.requireSpecial) managed.push('specialChars(1)');
  if (next.historyCount && next.historyCount > 0) managed.push(`passwordHistory(${next.historyCount})`);
  if (next.expiryDays && next.expiryDays > 0) managed.push(`forceExpiredPasswordChange(${next.expiryDays})`);
  return [...managed, ...kept].join(' and ');
}

/**
 * The minimum length actually enforced: SDK sign-up checks the project config,
 * Keycloak checks its own policy, so the stricter of the two is what a user
 * runs into.
 */
export function effectiveMinLength(configMin: number | null | undefined, policy: string | null | undefined): number {
  return Math.max(configMin ?? 0, parsePasswordPolicy(policy).minLength);
}

/** Every rule the password breaks, as user-facing sentences. Empty when it passes. */
export function passwordViolations(password: string, rules: Pick<PasswordRules, 'minLength' | 'requireUppercase' | 'requireLowercase' | 'requireDigits' | 'requireSpecial'>): string[] {
  const out: string[] = [];
  if (password.length < rules.minLength) out.push(`at least ${rules.minLength} characters`);
  if (rules.requireUppercase && !/[A-Z]/.test(password)) out.push('an uppercase letter');
  if (rules.requireLowercase && !/[a-z]/.test(password)) out.push('a lowercase letter');
  if (rules.requireDigits && !/[0-9]/.test(password)) out.push('a digit');
  if (rules.requireSpecial && !/[^A-Za-z0-9]/.test(password)) out.push('a special character');
  return out;
}

/** Throws a 400 naming every unmet rule. */
export function assertPasswordMeetsPolicy(password: unknown, rules: Parameters<typeof passwordViolations>[1]): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new BadRequestException('Password is required');
  }
  if (password.length > 256) throw new BadRequestException('Password must be at most 256 characters');
  const missing = passwordViolations(password, rules);
  if (missing.length) {
    throw new BadRequestException(`The password does not meet this project's policy: it needs ${missing.join(', ')}.`);
  }
  return password;
}

export interface PolicyUpdate {
  bruteForceProtected?: boolean;
  permanentLockout?: boolean;
  failureFactor?: number;
  waitIncrementSeconds?: number;
  maxFailureWaitSeconds?: number;
  password?: Partial<PasswordRules>;
  accessTokenLifespanSeconds?: number;
}

/**
 * Validate a PUT /auth/policies body. Out-of-range values are refused with a
 * message instead of being clamped, so what the form shows after saving is
 * exactly what was asked for.
 */
export function validatePolicyUpdate(body: Record<string, any> | null | undefined): PolicyUpdate {
  const b = body ?? {};
  const out: PolicyUpdate = {};
  for (const k of ['bruteForceProtected', 'permanentLockout'] as const) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== 'boolean') throw new BadRequestException(`${k} must be true or false`);
      out[k] = b[k];
    }
  }
  if (b.failureFactor !== undefined) out.failureFactor = intIn(b.failureFactor, 'Max login failures', POLICY_BOUNDS.failureFactor);
  if (b.waitIncrementSeconds !== undefined) {
    out.waitIncrementSeconds = intIn(b.waitIncrementSeconds, 'Wait increment', POLICY_BOUNDS.waitIncrementSeconds);
  }
  if (b.maxFailureWaitSeconds !== undefined) {
    out.maxFailureWaitSeconds = intIn(b.maxFailureWaitSeconds, 'Max wait', POLICY_BOUNDS.maxFailureWaitSeconds);
  }
  if (
    out.waitIncrementSeconds !== undefined &&
    out.maxFailureWaitSeconds !== undefined &&
    out.maxFailureWaitSeconds < out.waitIncrementSeconds
  ) {
    throw new BadRequestException('Max wait must be at least the wait increment');
  }
  if (b.accessTokenLifespanSeconds !== undefined) {
    out.accessTokenLifespanSeconds = intIn(b.accessTokenLifespanSeconds, 'Access token lifetime (seconds)', TOKEN_LIFESPAN_BOUNDS);
  }
  if (b.password !== undefined) {
    if (typeof b.password !== 'object' || b.password === null) throw new BadRequestException('password must be an object');
    const p = b.password;
    const pw: Partial<PasswordRules> = {};
    if (p.minLength !== undefined) pw.minLength = intIn(p.minLength, 'Minimum password length', PASSWORD_MIN_LENGTH_BOUNDS);
    for (const k of ['requireUppercase', 'requireLowercase', 'requireDigits', 'requireSpecial'] as const) {
      if (p[k] !== undefined) {
        if (typeof p[k] !== 'boolean') throw new BadRequestException(`password.${k} must be true or false`);
        pw[k] = p[k];
      }
    }
    if (p.historyCount !== undefined) pw.historyCount = intIn(p.historyCount, 'Password history', POLICY_BOUNDS.historyCount);
    if (p.expiryDays !== undefined) pw.expiryDays = intIn(p.expiryDays, 'Password expiry (days)', POLICY_BOUNDS.expiryDays);
    out.password = pw;
  }
  return out;
}

// ── Auth config ─────────────────────────────────────────────────────────────

/**
 * Scalar fields of ProjectAuthConfig a PUT may write. `id`, `projectId` and the
 * `project` relation are deliberately absent: passing the body straight to
 * Prisma let a caller re-point the row or write through to the project.
 */
export const WRITABLE_AUTH_CONFIG_FIELDS = new Set<string>([
  'allowSignup', 'requireEmailVerify', 'minPasswordLength', 'tokenExpirySeconds',
  'emailProvider', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'senderEmail', 'senderName',
  'resendApiKey', 'sendgridApiKey', 'sesAccessKey', 'sesSecretKey', 'sesRegion',
  'verifyEmailSubject', 'verifyEmailBody', 'resetPasswordSubject', 'resetPasswordBody',
  'welcomeSubject', 'welcomeBody', 'inviteUserSubject', 'inviteUserBody',
  'magicLinkSubject', 'magicLinkBody', 'changeEmailSubject', 'changeEmailBody',
  'reauthSubject', 'reauthBody', 'redirectUrls',
  'googleEnabled', 'googleClientId', 'googleClientSecret',
  'githubEnabled', 'githubClientId', 'githubClientSecret',
  'microsoftEnabled', 'microsoftClientId', 'microsoftClientSecret',
  'appleEnabled', 'appleClientId', 'appleClientSecret',
  'gitlabEnabled', 'gitlabClientId', 'gitlabClientSecret',
  'linkedinEnabled', 'linkedinClientId', 'linkedinClientSecret',
  'facebookEnabled', 'facebookClientId', 'facebookClientSecret',
  'twitterEnabled', 'twitterClientId', 'twitterClientSecret',
  'allowAnonymous', 'mfaEnforceEnrollment',
]);

/** Fields that decide where project emails are sent from. */
export const EMAIL_PROVIDER_FIELDS = [
  'emailProvider', 'smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'senderEmail', 'senderName',
  'resendApiKey', 'sendgridApiKey', 'sesAccessKey', 'sesSecretKey', 'sesRegion',
] as const;

const SMTP_FIELDS = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass'] as const;

const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Normalise and check a PUT /auth/config body against the stored row.
 *
 * - Unknown keys are refused (they used to reach Prisma and fail as a 500).
 * - Numbers must be in range instead of being silently replaced.
 * - When the body touches the email provider, the resulting provider must be
 *   complete: an SMTP provider without a host saved fine and then failed every
 *   verification and reset email. Choosing the platform default (null) also
 *   clears the SMTP fields, because the sender treats a stored SMTP host with
 *   no provider as "use SMTP".
 */
export function prepareAuthConfigUpdate(
  body: Record<string, any> | null | undefined,
  stored: Record<string, any>,
): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Expected a JSON object');
  }
  const unknown = Object.keys(body).filter((k) => !WRITABLE_AUTH_CONFIG_FIELDS.has(k));
  if (unknown.length) {
    throw new BadRequestException(`Unknown auth setting(s): ${unknown.join(', ')}`);
  }
  const data: Record<string, any> = { ...body };

  if (data.minPasswordLength !== undefined) {
    data.minPasswordLength = intIn(data.minPasswordLength, 'Minimum password length', PASSWORD_MIN_LENGTH_BOUNDS);
  }
  if (data.tokenExpirySeconds !== undefined) {
    data.tokenExpirySeconds = intIn(data.tokenExpirySeconds, 'Token expiry (seconds)', TOKEN_LIFESPAN_BOUNDS);
  }
  for (const k of ['allowSignup', 'requireEmailVerify', 'allowAnonymous', 'mfaEnforceEnrollment'] as const) {
    if (data[k] !== undefined && typeof data[k] !== 'boolean') {
      throw new BadRequestException(`${k} must be true or false`);
    }
  }

  const touchesEmail = EMAIL_PROVIDER_FIELDS.some((k) => k in data);
  if (!touchesEmail) return data;

  if ('emailProvider' in data) {
    const p = blank(data.emailProvider) ? null : String(data.emailProvider).trim().toLowerCase();
    if (p !== null && !(EMAIL_PROVIDERS as readonly string[]).includes(p)) {
      throw new BadRequestException(`Unknown email provider "${data.emailProvider}". Use one of: ${EMAIL_PROVIDERS.join(', ')}, or null for the platform default.`);
    }
    data.emailProvider = p;
    if (p === null) {
      for (const k of SMTP_FIELDS) if (!(k in body)) data[k] = null;
    }
  }
  for (const k of ['smtpHost', 'smtpUser', 'senderEmail', 'senderName', 'sesRegion'] as const) {
    if (k in data) data[k] = blank(data[k]) ? null : String(data[k]).trim();
  }
  if (data.smtpPort !== undefined && data.smtpPort !== null && data.smtpPort !== '') {
    data.smtpPort = intIn(data.smtpPort, 'SMTP port', { min: 1, max: 65_535 });
  } else if ('smtpPort' in data) {
    data.smtpPort = null;
  }
  // An empty secret means "keep the saved one", which is what the form sends
  // when the field was left untouched.
  for (const k of ['smtpPass', 'resendApiKey', 'sendgridApiKey', 'sesAccessKey', 'sesSecretKey'] as const) {
    if (k in data && data[k] === '') delete data[k];
  }

  const merged = { ...stored, ...data };
  const provider: string | null = merged.emailProvider ?? null;
  const problems: string[] = [];
  if (merged.senderEmail && !isValidEmail(merged.senderEmail)) problems.push('sender email is not a valid address');
  if (provider) {
    if (blank(merged.senderEmail)) problems.push('sender email is required with your own provider');
    if (provider === 'smtp') {
      if (blank(merged.smtpHost)) problems.push('SMTP host is required');
      else if (/\s|\/|:/.test(merged.smtpHost)) problems.push('SMTP host must be a host name such as smtp.example.com');
      if (blank(merged.smtpPort)) problems.push('SMTP port is required');
      if (blank(merged.smtpUser)) problems.push('SMTP username is required');
      if (blank(merged.smtpPass)) problems.push('SMTP password is required');
    } else if (provider === 'resend') {
      if (blank(merged.resendApiKey)) problems.push('Resend API key is required');
    } else if (provider === 'sendgrid') {
      if (blank(merged.sendgridApiKey)) problems.push('SendGrid API key is required');
    } else if (provider === 'ses') {
      if (blank(merged.sesAccessKey)) problems.push('SES access key is required');
      if (blank(merged.sesSecretKey)) problems.push('SES secret key is required');
      if (blank(merged.sesRegion)) problems.push('SES region is required');
    }
  }
  if (problems.length) {
    throw new BadRequestException(`Email settings were not saved: ${problems.join('; ')}.`);
  }
  return data;
}
