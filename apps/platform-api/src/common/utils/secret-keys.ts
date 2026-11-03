import { createHash, randomBytes } from 'crypto';

/** Every additional server-side key starts with this, so a lookup knows where to look. */
export const SECRET_KEY_PREFIX = 'bf_secret_';

/** A new secret key: 32 random bytes, URL-safe. Shown once; only its hash is kept. */
export function generateSecretKey(): string {
  return `${SECRET_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** A new legacy-format service key, for rotating the project's service_role key. */
export function generateServiceKey(): string {
  return `bf_service_${randomBytes(32).toString('base64url')}`;
}

export function isSecretKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(SECRET_KEY_PREFIX);
}

/** What is stored and looked up: never the key itself. */
export function hashSecretKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Enough of a key to recognise it in a list: `bf_secret_Ab3x…9fQz`. */
export function keyHint(key: string): { prefix: string; last4: string } {
  const head = key.startsWith(SECRET_KEY_PREFIX) ? SECRET_KEY_PREFIX.length + 4 : Math.min(15, key.length - 4);
  return { prefix: key.slice(0, Math.max(0, head)), last4: key.slice(-4) };
}

/** A key as the dashboard may show it once it is no longer revealable. */
export function maskKey(key: string): string {
  const { prefix, last4 } = keyHint(key);
  return `${prefix}…${last4}`;
}
