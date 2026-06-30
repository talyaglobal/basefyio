// Set a 32-byte key before importing (the module reads the env lazily + caches).
process.env.DB_CRED_ENC_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

import {
  encryptField,
  decryptField,
  isEncrypted,
  isEncryptionEnabled,
} from './field-crypto';

describe('field-crypto', () => {
  it('reports encryption enabled when a key is set', () => {
    expect(isEncryptionEnabled()).toBe(true);
  });

  it('round-trips a value (ciphertext hides plaintext)', () => {
    const enc = encryptField('s3cret-password') as string;
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain('s3cret-password');
    expect(decryptField(enc)).toBe('s3cret-password');
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(encryptField('same')).not.toBe(encryptField('same'));
  });

  it('does not double-encrypt an already-encrypted value', () => {
    const once = encryptField('x') as string;
    expect(encryptField(once)).toBe(once);
  });

  it('passes plaintext through on decrypt (not-yet-migrated values)', () => {
    expect(decryptField('plain-text')).toBe('plain-text');
  });

  it('handles null/empty without throwing', () => {
    expect(encryptField('')).toBe('');
    expect(encryptField(null)).toBeNull();
    expect(decryptField(undefined)).toBeUndefined();
  });
});
