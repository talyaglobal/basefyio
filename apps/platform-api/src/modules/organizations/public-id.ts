import { randomBytes } from 'crypto';

/** 16 random bytes in base 36: twenty lowercase characters, 128 bits of entropy. */
export const PUBLIC_ID_LENGTH = 20;

const PUBLIC_ID_PATTERN = /^[a-z0-9]{20}$/;

/**
 * An organization's address in the dashboard. Opaque — it carries nothing
 * about the name, the owner or the plan — and stable for the life of the
 * row. Base 36 keeps it lowercase and URL-safe without padding characters.
 */
export function newPublicId(): string {
  // Two 64-bit halves, each rendered in base 36 and zero-padded, give a
  // fixed width without BigInt arithmetic on the whole 128 bits.
  const bytes = randomBytes(16);
  const hi = bytes.readBigUInt64BE(0).toString(36).padStart(13, '0');
  const lo = bytes.readBigUInt64BE(8).toString(36).padStart(13, '0');
  return (hi + lo).slice(-PUBLIC_ID_LENGTH);
}

export function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
