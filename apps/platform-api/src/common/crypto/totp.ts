import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238) over HMAC-SHA1 (RFC 4226), plus the
 * RFC 4648 base32 alphabet that authenticator apps expect in the otpauth URI.
 *
 * Pure functions, no I/O. Kept dependency-free on purpose: the RFC test
 * vectors in totp.spec.ts prove the arithmetic, which is the only thing a
 * library would add here. The defaults (SHA1, 6 digits, 30 s) are what every
 * mainstream authenticator app enrolls by default.
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
export const TOTP_ALGORITHM = 'SHA1';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer | Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, whitespace, dashes and `=` padding; refuses anything else. */
export function base32Decode(input: string): Buffer {
  const clean = String(input ?? '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The 30-second step a point in time falls into. */
export function totpStep(nowMs: number = Date.now(), period = TOTP_PERIOD): number {
  return Math.floor(nowMs / 1000 / period);
}

/** The code an authenticator shows for a given step. */
export function totpCode(secretBase32: string, step: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), step, digits);
}

/** 20 random bytes, the length RFC 4226 recommends, as 32 base32 characters. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export interface VerifyTotpOptions {
  /** Steps of clock drift accepted on each side of now. Default 1 (30 s). */
  window?: number;
  nowMs?: number;
  /**
   * The last step that was already accepted for this secret. A code for that
   * step or an earlier one is refused, so an intercepted code cannot be
   * replayed inside the window (RFC 6238 §5.2).
   */
  minStep?: number | null;
  digits?: number;
  period?: number;
}

export interface VerifyTotpResult {
  ok: boolean;
  /** The step that matched (also set when the match was refused as a replay). */
  step: number | null;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: VerifyTotpOptions = {},
): VerifyTotpResult {
  const digits = opts.digits ?? TOTP_DIGITS;
  const window = opts.window ?? 1;
  const normalized = String(code ?? '').replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return { ok: false, step: null };

  const current = totpStep(opts.nowMs ?? Date.now(), opts.period ?? TOTP_PERIOD);
  const secret = base32Decode(secretBase32);

  let matched: number | null = null;
  // Every candidate is computed and compared, whether or not an earlier one
  // matched, so the time taken does not say which step the code belonged to.
  for (let delta = -window; delta <= window; delta++) {
    const step = current + delta;
    if (safeEqual(hotp(secret, step, digits), normalized) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, step: null };
  if (opts.minStep != null && matched <= opts.minStep) return { ok: false, step: matched };
  return { ok: true, step: matched };
}

/** The URI an authenticator app reads from a QR code. */
export function otpauthUri(params: {
  issuer: string;
  account: string;
  secret: string;
  digits?: number;
  period?: number;
}): string {
  const issuer = encodeURIComponent(params.issuer);
  const account = encodeURIComponent(params.account);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(params.digits ?? TOTP_DIGITS),
    period: String(params.period ?? TOTP_PERIOD),
  });
  return `otpauth://totp/${issuer}:${account}?${query.toString()}`;
}

// ── Recovery codes ────────────────────────────────────────────────────────

const RECOVERY_CODE_LENGTH = 10;

/** Strips separators and case so a code typed with or without the dash compares equal. */
export function normalizeRecoveryCode(code: string): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** One-time codes shown to the person once, in the form XXXXX-XXXXX. */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const raw = base32Encode(randomBytes(10)).slice(0, RECOVERY_CODE_LENGTH);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
