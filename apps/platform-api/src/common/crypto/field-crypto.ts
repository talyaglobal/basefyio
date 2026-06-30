import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Transparent field-level encryption for credentials stored at rest (e.g. a
 * project's database password). Ciphertext is tagged with an `enc:v1:` prefix so
 * plaintext (not-yet-migrated) values pass through untouched — making the
 * rollout safe and reversible. AES-256-GCM (authenticated).
 *
 * The key comes from DB_CRED_ENC_KEY (base64- or hex-encoded 32 bytes). If it is
 * absent the helpers are a no-op: nothing is ever encrypted, so existing
 * plaintext keeps working. Encryption only activates once a key is configured.
 */

const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null | undefined;

function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.DB_CRED_ENC_KEY?.trim();
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }
  let key: Buffer | null = null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      key = Buffer.from(raw, 'hex');
    } else {
      const b = Buffer.from(raw, 'base64');
      if (b.length === 32) key = b;
    }
  } catch {
    key = null;
  }
  cachedKey = key && key.length === 32 ? key : null;
  return cachedKey;
}

export function isEncryptionEnabled(): boolean {
  return getKey() !== null;
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt a plaintext value. No-op if no key, empty, or already encrypted. */
export function encryptField(value: string | null | undefined): string | null | undefined {
  if (value == null || value === '') return value;
  if (isEncrypted(value)) return value;
  const key = getKey();
  if (!key) return value; // encryption disabled — keep plaintext
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a value. Returns plaintext as-is (not `enc:v1:` prefixed). */
export function decryptField(value: string | null | undefined): string | null | undefined {
  if (value == null || !isEncrypted(value)) return value;
  const key = getKey();
  if (!key) return value; // misconfig: can't decrypt — surface ciphertext rather than crash
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
