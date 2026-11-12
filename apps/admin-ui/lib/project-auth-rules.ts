/**
 * Input rules for a project's end users and auth settings — the browser copy of
 * platform-api `project-auth-validation.ts`, used for inline errors. The server
 * enforces the same rules; keep the two in step.
 *
 * (Not to be confused with `password-policy.ts`, which is about basefyio
 * dashboard accounts.)
 */
import type { RealmPolicies } from '@/lib/types';

export const PASSWORD_MIN_LENGTH_BOUNDS = { min: 6, max: 128 } as const;
export const TOKEN_LIFESPAN_BOUNDS = { min: 300, max: 86_400 } as const;
export const POLICY_BOUNDS = {
  failureFactor: { min: 1, max: 100 },
  waitIncrementSeconds: { min: 1, max: 86_400 },
  maxFailureWaitSeconds: { min: 1, max: 86_400 },
  historyCount: { min: 0, max: 24 },
  expiryDays: { min: 0, max: 3_650 },
} as const;

const EMAIL_RE = /^[^\s@]+@(?:[^\s@.]+\.)+[^\s@.]{2,}$/;

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value.trim());
}

/** E.164 after dropping spaces, dashes, dots and brackets; '' when empty; null when invalid. */
export function normalizePhone(value: string): string | null {
  const compact = value.replace(/[\s().-]/g, '');
  if (compact === '') return '';
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
}

/** An error message when `value` is not a whole number in range, else null. */
export function rangeError(value: string | number, label: string, bounds: { min: number; max: number }): string | null {
  const n = typeof value === 'number' ? value : value.trim() === '' ? NaN : Number(value);
  if (!Number.isInteger(n)) return `${label} must be a whole number`;
  if (n < bounds.min || n > bounds.max) return `${label} must be between ${bounds.min} and ${bounds.max}`;
  return null;
}

export type PasswordRules = Pick<
  RealmPolicies['password'],
  'minLength' | 'requireUppercase' | 'requireLowercase' | 'requireDigits' | 'requireSpecial'
>;

/** The checklist a password is held to, one entry per active rule. */
export function passwordChecks(rules: PasswordRules): { label: string; test: (p: string) => boolean }[] {
  const checks: { label: string; test: (p: string) => boolean }[] = [
    { label: `At least ${rules.minLength} characters`, test: (p) => p.length >= rules.minLength },
  ];
  if (rules.requireUppercase) checks.push({ label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) });
  if (rules.requireLowercase) checks.push({ label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) });
  if (rules.requireDigits) checks.push({ label: 'A digit', test: (p) => /[0-9]/.test(p) });
  if (rules.requireSpecial) checks.push({ label: 'A special character', test: (p) => /[^A-Za-z0-9]/.test(p) });
  return checks;
}

/** Used until the project's policy has loaded; the server re-checks anyway. */
export const DEFAULT_PASSWORD_RULES: PasswordRules = {
  minLength: 6,
  requireUppercase: false,
  requireLowercase: false,
  requireDigits: false,
  requireSpecial: false,
};
