import { createHash, randomBytes } from 'crypto';
import { TOKEN_PREFIX } from './api-tokens.constants';

/** Generate a fresh token secret + its storage hash + a display prefix. */
export function generateToken(): { token: string; hash: string; prefix: string } {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 15) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isPlatformToken(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX);
}
