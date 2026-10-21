import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp';

/**
 * RFC 6238 Appendix B, SHA-1 column. The shared secret is the ASCII string
 * "12345678901234567890"; T is the Unix time, the step is T / 30.
 */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('totp — RFC 6238 vectors', () => {
  it.each(RFC_VECTORS)('T=%d produces %s with 8 digits', (t, expected) => {
    expect(hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(expected);
    expect(totpCode(RFC_SECRET_B32, totpStep(t * 1000), 8)).toBe(expected);
  });

  it.each(RFC_VECTORS)('T=%d with 6 digits is the last six digits of %s', (t, expected) => {
    expect(totpCode(RFC_SECRET_B32, totpStep(t * 1000))).toBe(expected.slice(-6));
  });
});

describe('verifyTotp', () => {
  const now = 1111111111 * 1000;
  const step = totpStep(now);

  it('accepts the current step and one step of drift either side', () => {
    for (const delta of [-1, 0, 1]) {
      const code = totpCode(RFC_SECRET_B32, step + delta);
      expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now })).toEqual({ ok: true, step: step + delta });
    }
  });

  it('refuses two steps of drift', () => {
    for (const delta of [-2, 2]) {
      const code = totpCode(RFC_SECRET_B32, step + delta);
      expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now }).ok).toBe(false);
    }
  });

  it('refuses a replayed code: a step at or before the last accepted one', () => {
    const code = totpCode(RFC_SECRET_B32, step);
    expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now, minStep: step })).toEqual({ ok: false, step });
    expect(verifyTotp(RFC_SECRET_B32, code, { nowMs: now, minStep: step - 1 }).ok).toBe(true);
  });

  it('refuses malformed input without touching the secret', () => {
    expect(verifyTotp(RFC_SECRET_B32, '12345', { nowMs: now }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, 'abcdef', { nowMs: now }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET_B32, '', { nowMs: now }).ok).toBe(false);
  });

  it('ignores spaces people type between digit groups', () => {
    const code = totpCode(RFC_SECRET_B32, step);
    expect(verifyTotp(RFC_SECRET_B32, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now }).ok).toBe(true);
  });
});

describe('base32', () => {
  it('round-trips every length from 1 to 40 bytes', () => {
    for (let n = 1; n <= 40; n++) {
      const buf = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) % 256));
      expect(base32Decode(base32Encode(buf))).toEqual(buf);
    }
  });

  it('matches the RFC 4648 examples', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar');
  });

  it('decoding ignores case, whitespace, dashes and padding', () => {
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
  });

  it('decoding refuses characters outside the alphabet', () => {
    expect(() => base32Decode('MZXW6YTB01')).toThrow(/base32/);
  });

  it('a generated secret is 20 bytes shown as 32 characters', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });
});

describe('otpauthUri', () => {
  it('encodes issuer and account and carries the algorithm, digits and period', () => {
    const uri = otpauthUri({ issuer: 'My App', account: 'ada@example.com', secret: 'JBSWY3DPEHPK3PXP' });
    expect(uri.startsWith('otpauth://totp/My%20App:ada%40example.com?')).toBe(true);
    const query = new URL(uri).searchParams;
    expect(query.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(query.get('issuer')).toBe('My App');
    expect(query.get('algorithm')).toBe('SHA1');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
  });
});

describe('recovery codes', () => {
  it('generates eight distinct codes in the XXXXX-XXXXX form', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  it('normalises case and separators so the hash is stable', () => {
    expect(normalizeRecoveryCode('ab-cde fg')).toBe('ABCDEFG');
    expect(hashRecoveryCode('abcde-fghjk')).toBe(hashRecoveryCode('ABCDE FGHJK'));
    expect(hashRecoveryCode('ABCDEFGHJK')).toMatch(/^[0-9a-f]{64}$/);
  });
});
