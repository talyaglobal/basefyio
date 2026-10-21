import { createCipheriv, createDecipheriv, createHash, randomBytes, DecipherGCM } from 'crypto';
import { Transform, TransformCallback } from 'stream';

/**
 * Streaming encryption for backup artifacts — format "BFENC1".
 *
 * A backup leaves the server as one object, often several gigabytes, so the
 * cipher has to work as a stream. AES-256-GCM is authenticated: a bit flipped
 * in transit or at rest fails decryption instead of yielding garbage SQL.
 *
 *   offset  size  content
 *   0       6     ASCII "BFENC1"
 *   6       1     version 0x01 (AES-256-GCM, 12-byte IV, 16-byte tag)
 *   7       4     key fingerprint = SHA-256(key)[0..4]
 *   11      12    IV, random per object
 *   23      n     ciphertext (same length as the plaintext)
 *   23+n    16    GCM authentication tag
 *
 * The 23-byte header is bound to the ciphertext as additional authenticated
 * data, so it cannot be swapped between objects. The fingerprint lets a
 * decryptor say "wrong key" rather than "corrupt file".
 *
 * The key is BACKUP_ENC_KEY: 32 bytes, base64- or hex-encoded — deliberately a
 * different variable from DB_CRED_ENC_KEY so either can rotate on its own.
 *
 * scripts/backup-decrypt.mjs implements the same format standalone for
 * operators; backup-crypto.spec.ts keeps the two in step.
 */

export const BFENC_MAGIC = Buffer.from('BFENC1', 'ascii');
export const BFENC_VERSION = 0x01;
export const BFENC_HEADER_LENGTH = 6 + 1 + 4 + 12;
export const BFENC_TAG_LENGTH = 16;
/** Bytes added to a plaintext of any length. */
export const BFENC_OVERHEAD = BFENC_HEADER_LENGTH + BFENC_TAG_LENGTH;
/** Appended to object keys that hold an encrypted artifact. */
export const ENCRYPTED_SUFFIX = '.enc';

const IV_LENGTH = 12;
const FINGERPRINT_LENGTH = 4;

let cachedKey: Buffer | null | undefined;

/** Parse a 32-byte key given as 64 hex characters or base64. Null when unusable. */
export function parseBackupKey(raw: string | undefined | null): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
    const b = Buffer.from(value, 'base64');
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** The configured BACKUP_ENC_KEY, or null when encryption is not set up. Cached per process. */
export function getBackupKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = parseBackupKey(process.env.BACKUP_ENC_KEY);
  return cachedKey;
}

/** Tests change the environment between cases; production never calls this. */
export function resetBackupKeyCache(): void {
  cachedKey = undefined;
}

export function isBackupEncryptionEnabled(): boolean {
  return getBackupKey() !== null;
}

export function keyFingerprint(key: Buffer): Buffer {
  return createHash('sha256').update(key).digest().subarray(0, FINGERPRINT_LENGTH);
}

/** Size of the encrypted object for a plaintext of `plainBytes`. */
export function encryptedSize(plainBytes: number): number {
  return plainBytes + BFENC_OVERHEAD;
}

/** Size of the plaintext inside an encrypted object of `encryptedBytes`. */
export function plaintextSize(encryptedBytes: number): number {
  return Math.max(0, encryptedBytes - BFENC_OVERHEAD);
}

function buildHeader(key: Buffer, iv: Buffer): Buffer {
  return Buffer.concat([
    BFENC_MAGIC,
    Buffer.from([BFENC_VERSION]),
    keyFingerprint(key),
    iv,
  ]);
}

/**
 * Transform that turns a plaintext stream into a BFENC1 stream. The header is
 * emitted with the first chunk (or on flush for an empty input); the tag goes
 * last.
 */
export function createEncryptStream(key: Buffer): Transform {
  if (key.length !== 32) throw new Error('BACKUP_ENC_KEY must be exactly 32 bytes');
  const iv = randomBytes(IV_LENGTH);
  const header = buildHeader(key, iv);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  let headerSent = false;

  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        if (!headerSent) {
          headerSent = true;
          this.push(header);
        }
        const out = cipher.update(chunk);
        if (out.length) this.push(out);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!headerSent) {
          headerSent = true;
          this.push(header);
        }
        const last = cipher.final();
        if (last.length) this.push(last);
        this.push(cipher.getAuthTag());
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

export class BackupDecryptError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-encrypted' | 'unsupported-version' | 'wrong-key' | 'truncated' | 'authentication',
  ) {
    super(message);
    this.name = 'BackupDecryptError';
  }
}

/**
 * Transform that turns a BFENC1 stream back into plaintext.
 *
 * GCM can only check the tag at the very end, so plaintext is emitted before
 * it is authenticated — the standard streaming caveat. Callers therefore write
 * to a temporary path and rename only once the stream has ended without error.
 */
export function createDecryptStream(key: Buffer): Transform {
  if (key.length !== 32) throw new Error('BACKUP_ENC_KEY must be exactly 32 bytes');
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  // The last 16 bytes of the stream are the tag, not ciphertext. Hold back
  // that many bytes until more arrive or the stream ends.
  let tail = Buffer.alloc(0);

  const startDecipher = (): Error | null => {
    if (!header.subarray(0, BFENC_MAGIC.length).equals(BFENC_MAGIC)) {
      return new BackupDecryptError('Not a basefyio encrypted backup (missing BFENC1 header)', 'not-encrypted');
    }
    if (header[6] !== BFENC_VERSION) {
      return new BackupDecryptError(`Unsupported encrypted backup version ${header[6]}`, 'unsupported-version');
    }
    const fp = header.subarray(7, 7 + FINGERPRINT_LENGTH);
    if (!fp.equals(keyFingerprint(key))) {
      return new BackupDecryptError(
        'BACKUP_ENC_KEY does not match the key this backup was encrypted with',
        'wrong-key',
      );
    }
    const iv = header.subarray(7 + FINGERPRINT_LENGTH, BFENC_HEADER_LENGTH);
    decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(header);
    return null;
  };

  return new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      try {
        let data = chunk;
        if (!decipher) {
          header = Buffer.concat([header, data]);
          if (header.length < BFENC_HEADER_LENGTH) return cb();
          data = header.subarray(BFENC_HEADER_LENGTH);
          header = header.subarray(0, BFENC_HEADER_LENGTH);
          const err = startDecipher();
          if (err) return cb(err);
        }
        const buf = Buffer.concat([tail, data]);
        if (buf.length <= BFENC_TAG_LENGTH) {
          tail = buf;
          return cb();
        }
        const body = buf.subarray(0, buf.length - BFENC_TAG_LENGTH);
        tail = Buffer.from(buf.subarray(buf.length - BFENC_TAG_LENGTH));
        const out = decipher!.update(body);
        if (out.length) this.push(out);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!decipher) {
          return cb(new BackupDecryptError('Encrypted backup is truncated (header incomplete)', 'truncated'));
        }
        if (tail.length < BFENC_TAG_LENGTH) {
          return cb(new BackupDecryptError('Encrypted backup is truncated (tag incomplete)', 'truncated'));
        }
        decipher.setAuthTag(tail);
        const last = decipher.final();
        if (last.length) this.push(last);
        cb();
      } catch (err: any) {
        if (err instanceof BackupDecryptError) return cb(err);
        cb(
          new BackupDecryptError(
            'Encrypted backup failed authentication — it was altered or does not belong to this key',
            'authentication',
          ),
        );
      }
    },
  });
}
