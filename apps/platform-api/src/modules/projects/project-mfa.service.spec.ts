// field-crypto reads the key lazily on first use; set it before anything runs.
process.env.DB_CRED_ENC_KEY = Buffer.alloc(32, 7).toString('base64');

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../redis/redis.service', () => ({ RedisService: class {} }));

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ProjectMfaService } from './project-mfa.service';
import { hashRecoveryCode, totpCode, totpStep } from '../../common/crypto/totp';

/**
 * The second factor without Keycloak: the secret is encrypted in the row, the
 * parked tokens are encrypted in Redis, a code works once, and wrong codes run
 * out. Prisma and Redis are in-memory fakes; the clock is pinned so every code
 * is deterministic.
 */

class FakeRedis {
  store = new Map<string, string>();
  ttl = new Map<string, number>();
  async set(key: string, value: string, ttlSeconds: number) {
    this.store.set(key, value);
    this.ttl.set(key, ttlSeconds);
  }
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async del(key: string) {
    this.store.delete(key);
    this.ttl.delete(key);
  }
  async incr(key: string) {
    const n = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(n));
    return n;
  }
  async expire(key: string, seconds: number) {
    this.ttl.set(key, seconds);
  }
  async getdel(key: string) {
    const v = this.store.get(key) ?? null;
    this.store.delete(key);
    return v;
  }
}

function fakePrisma() {
  const rows = new Map<string, any>();
  const keyOf = (where: any) =>
    `${where.projectId_keycloakUserId.projectId}:${where.projectId_keycloakUserId.keycloakUserId}`;
  const blank = (projectId: string, keycloakUserId: string) => ({
    id: `row-${rows.size + 1}`,
    projectId,
    keycloakUserId,
    totpSecretEnc: null,
    pendingSecretEnc: null,
    pendingCreatedAt: null,
    verifiedAt: null,
    lastUsedStep: null,
    lastUsedAt: null,
    recoveryCodeHashes: [],
    enrollmentRequiredAt: null,
  });
  const prisma = {
    projectUserMfa: {
      findUnique: jest.fn(async ({ where }: any) => rows.get(keyOf(where)) ?? null),
      findMany: jest.fn(async ({ where }: any) =>
        [...rows.values()].filter(
          (r) => r.projectId === where.projectId && (where.verifiedAt ? r.verifiedAt != null : true),
        ),
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = keyOf(where);
        const cur = rows.get(k);
        const next = cur
          ? { ...cur, ...update }
          : { ...blank(create.projectId, create.keycloakUserId), ...create };
        rows.set(k, next);
        return next;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const k = keyOf(where);
        const cur = rows.get(k);
        if (!cur) throw new Error('row not found');
        const next = { ...cur, ...data };
        rows.set(k, next);
        return next;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (const [k, r] of rows) {
          if (r.projectId === where.projectId && r.keycloakUserId === where.keycloakUserId) {
            rows.delete(k);
            count++;
          }
        }
        return { count };
      }),
    },
  };
  return { prisma, rows, row: (p: string, u: string) => rows.get(`${p}:${u}`) };
}

const T0 = 1_700_000_000_000; // a fixed instant; codes are derived from it
const TOKENS = { accessToken: 'at', refreshToken: 'rt', expiresIn: 1800, tokenType: 'Bearer' };

function build(config: Record<string, unknown> = {}) {
  const redis = new FakeRedis();
  const db = fakePrisma();
  const svc = new ProjectMfaService(
    db.prisma as any,
    redis as any,
    { get: (k: string) => config[k] } as any,
  );
  let nowMs = T0;
  jest.spyOn(svc as any, 'now').mockImplementation(() => nowMs);
  const advance = (seconds: number) => {
    nowMs += seconds * 1000;
  };
  const codeAt = (secret: string, offsetSteps = 0) => totpCode(secret, totpStep(nowMs) + offsetSteps);
  return { svc, redis, db, advance, codeAt, now: () => nowMs };
}

/** Enroll u1 on p1 and return the plaintext secret and recovery codes. */
async function enrolled(ctx: ReturnType<typeof build>) {
  const e = await ctx.svc.beginEnrollment('p1', 'u1', { issuer: 'Shop', account: 'ada@example.com' });
  const result = await ctx.svc.confirmEnrollment('p1', 'u1', ctx.codeAt(e.secret));
  // Enrollment consumed the current step; move to the next one so a fresh code exists.
  ctx.advance(30);
  return { secret: e.secret, recoveryCodes: result.recoveryCodes };
}

const code = (err: any) => err?.getResponse?.()?.code;

describe('ProjectMfaService — enrollment', () => {
  it('stores the pending secret encrypted and returns it once, with a scannable URI', async () => {
    const ctx = build();
    const e = await ctx.svc.beginEnrollment('p1', 'u1', { issuer: 'Shop', account: 'ada@example.com' });
    expect(e.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(e.otpauthUrl).toContain(`secret=${e.secret}`);
    expect(e.otpauthUrl.startsWith('otpauth://totp/Shop:ada%40example.com?')).toBe(true);
    const row = ctx.db.row('p1', 'u1');
    expect(row.pendingSecretEnc.startsWith('enc:v1:')).toBe(true);
    expect(row.pendingSecretEnc).not.toContain(e.secret);
    expect(row.verifiedAt).toBeNull();
  });

  it('refuses to enroll over a confirmed factor, but lets a pending one be restarted', async () => {
    const ctx = build();
    const first = await ctx.svc.beginEnrollment('p1', 'u1', { issuer: 'Shop', account: 'a' });
    const second = await ctx.svc.beginEnrollment('p1', 'u1', { issuer: 'Shop', account: 'a' });
    expect(second.secret).not.toBe(first.secret);
    await ctx.svc.confirmEnrollment('p1', 'u1', ctx.codeAt(second.secret));
    await expect(
      ctx.svc.beginEnrollment('p1', 'u1', { issuer: 'Shop', account: 'a' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('a wrong code leaves the enrollment pending; the right one confirms it and hands out hashed recovery codes', async () => {
    const ctx = build();
    const e = await ctx.svc.beginEnrollment('p1', 'u1', { issuer: 'Shop', account: 'a' });
    const right = ctx.codeAt(e.secret);
    const wrong = right === '000000' ? '000001' : '000000';
    await expect(ctx.svc.confirmEnrollment('p1', 'u1', wrong)).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.db.row('p1', 'u1').verifiedAt).toBeNull();

    const result = await ctx.svc.confirmEnrollment('p1', 'u1', right);
    expect(result.enabled).toBe(true);
    expect(result.recoveryCodes).toHaveLength(8);
    const row = ctx.db.row('p1', 'u1');
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect(row.totpSecretEnc.startsWith('enc:v1:')).toBe(true);
    expect(row.pendingSecretEnc).toBeNull();
    expect(row.recoveryCodeHashes).toEqual(result.recoveryCodes.map(hashRecoveryCode));
    for (const c of result.recoveryCodes) expect(row.recoveryCodeHashes).not.toContain(c);
    expect(row.enrollmentRequiredAt).toBeNull();
  });

  it('confirming without a pending enrollment is a clear 400', async () => {
    const ctx = build();
    await expect(ctx.svc.confirmEnrollment('p1', 'u1', '123456')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to work without the encryption key rather than storing a secret in clear', async () => {
    const saved = process.env.DB_CRED_ENC_KEY;
    delete process.env.DB_CRED_ENC_KEY;
    let Svc: typeof ProjectMfaService | undefined;
    jest.isolateModules(() => {
      ({ ProjectMfaService: Svc } = require('./project-mfa.service'));
    });
    try {
      const svc = new Svc!(fakePrisma().prisma as any, new FakeRedis() as any, { get: () => undefined } as any);
      // The isolated registry loads its own copy of @nestjs/common, so class
      // identity cannot be compared; the status and the message can.
      const err = await svc.beginEnrollment('p1', 'u1', { issuer: 'Shop', account: 'a' }).catch((e) => e);
      expect(err.getStatus()).toBe(new ServiceUnavailableException().getStatus());
      expect(err.message).toMatch(/DB_CRED_ENC_KEY/);
    } finally {
      process.env.DB_CRED_ENC_KEY = saved;
    }
  });
});

describe('ProjectMfaService — sign-in challenges', () => {
  it('parks the tokens encrypted in Redis under a fresh challenge id with the configured TTL', async () => {
    const ctx = build({ MFA_CHALLENGE_TTL_SECONDS: '120' });
    await enrolled(ctx);
    const ch = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'verify', {
      emailVerified: true,
      account: 'ada@example.com',
    });
    expect(ch).toMatchObject({ mfaRequired: true, methods: ['totp', 'recovery'], expiresIn: 120, enrollmentRequired: false });
    expect(ch.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const key = `mfa_challenge:p1:${ch.challengeId}`;
    expect(ctx.redis.store.get(key)!.startsWith('enc:v1:')).toBe(true);
    expect(ctx.redis.store.get(key)).not.toContain('rt');
    expect(ctx.redis.ttl.get(key)).toBe(120);
  });

  it('a valid code releases the parked tokens exactly once', async () => {
    const ctx = build();
    const { secret } = await enrolled(ctx);
    const ch = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'verify', { emailVerified: true });
    const out = await ctx.svc.verifyChallenge('p1', ch.challengeId, { code: ctx.codeAt(secret) });
    expect(out).toEqual({ ...TOKENS, userId: 'u1', emailVerified: true });
    expect(ctx.redis.store.has(`mfa_challenge:p1:${ch.challengeId}`)).toBe(false);
    await expect(
      ctx.svc.verifyChallenge('p1', ch.challengeId, { code: ctx.codeAt(secret) }),
    ).rejects.toMatchObject({ response: { code: 'challenge_expired' } });
  });

  it('an unknown challenge id is refused', async () => {
    const ctx = build();
    const err = await ctx.svc.verifyChallenge('p1', 'nope', { code: '123456' }).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(code(err)).toBe('challenge_expired');
  });

  it('the same code cannot be used twice inside the window', async () => {
    const ctx = build();
    const { secret } = await enrolled(ctx);
    const used = ctx.codeAt(secret);
    const first = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'verify', {});
    await ctx.svc.verifyChallenge('p1', first.challengeId, { code: used });
    const second = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'verify', {});
    const err = await ctx.svc.verifyChallenge('p1', second.challengeId, { code: used }).catch((e) => e);
    expect(code(err)).toBe('invalid_code');
    // The next step's code works again.
    ctx.advance(30);
    await expect(
      ctx.svc.verifyChallenge('p1', second.challengeId, { code: ctx.codeAt(secret) }),
    ).resolves.toMatchObject({ accessToken: 'at' });
  });

  it('runs out after the configured number of wrong codes, destroys the challenge and revokes its session', async () => {
    const ctx = build({ MFA_MAX_ATTEMPTS: 3 });
    const { secret } = await enrolled(ctx);
    const ch = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'verify', {});
    const onExhausted = jest.fn().mockResolvedValue(undefined);
    const wrong = ctx.codeAt(secret) === '000000' ? '000001' : '000000';

    for (let i = 0; i < 2; i++) {
      const err = await ctx.svc.verifyChallenge('p1', ch.challengeId, { code: wrong }, onExhausted).catch((e) => e);
      expect(code(err)).toBe('invalid_code');
    }
    const third = await ctx.svc.verifyChallenge('p1', ch.challengeId, { code: wrong }, onExhausted).catch((e) => e);
    expect(code(third)).toBe('too_many_attempts');
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][0]).toMatchObject({ userId: 'u1', realm: 'realm', tokens: TOKENS });
    expect(ctx.redis.store.has(`mfa_challenge:p1:${ch.challengeId}`)).toBe(false);

    // Even the right code is too late now.
    const late = await ctx.svc.verifyChallenge('p1', ch.challengeId, { code: ctx.codeAt(secret) }).catch((e) => e);
    expect(code(late)).toBe('challenge_expired');
  });

  it('a recovery code releases the tokens and is spent', async () => {
    const ctx = build();
    const { recoveryCodes } = await enrolled(ctx);
    const first = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'verify', {});
    await expect(
      ctx.svc.verifyChallenge('p1', first.challengeId, { recoveryCode: recoveryCodes[0].toLowerCase() }),
    ).resolves.toMatchObject({ accessToken: 'at' });
    expect((await ctx.svc.status('p1', 'u1')).recoveryCodesLeft).toBe(7);

    const second = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'verify', {});
    const err = await ctx.svc.verifyChallenge('p1', second.challengeId, { recoveryCode: recoveryCodes[0] }).catch((e) => e);
    expect(code(err)).toBe('invalid_code');
  });

  it('an enrollment challenge cannot be completed with a code; it names the user for the enrollment routes', async () => {
    const ctx = build();
    const ch = await ctx.svc.createChallenge('p1', 'realm', 'u1', TOKENS, 'enroll', { account: 'ada@example.com' });
    expect(ch.enrollmentRequired).toBe(true);
    expect(ch.methods).toEqual(['totp']);
    await expect(ctx.svc.verifyChallenge('p1', ch.challengeId, { code: '123456' })).rejects.toBeInstanceOf(BadRequestException);
    const stored = await ctx.svc.peekChallenge('p1', ch.challengeId);
    expect(stored).toMatchObject({ kind: 'enroll', userId: 'u1', account: 'ada@example.com' });
    const released = await ctx.svc.consumeChallenge('p1', ch.challengeId);
    expect(released.tokens).toEqual(TOKENS);
    await expect(ctx.svc.peekChallenge('p1', ch.challengeId)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ProjectMfaService — management', () => {
  it('disable needs the factor itself; force does not', async () => {
    const ctx = build();
    const { secret } = await enrolled(ctx);
    await expect(ctx.svc.disable('p1', 'u1', {})).rejects.toBeInstanceOf(BadRequestException);
    const wrong = ctx.codeAt(secret) === '000000' ? '000001' : '000000';
    const err = await ctx.svc.disable('p1', 'u1', { code: wrong }).catch((e) => e);
    expect(code(err)).toBe('invalid_code');
    expect(ctx.db.row('p1', 'u1').verifiedAt).toBeInstanceOf(Date);

    await expect(ctx.svc.disable('p1', 'u1', { code: ctx.codeAt(secret) })).resolves.toEqual({ enabled: false });
    expect(ctx.db.row('p1', 'u1')).toBeUndefined();

    await enrolled(ctx);
    await expect(ctx.svc.disable('p1', 'u1', { force: true })).resolves.toEqual({ enabled: false });
    expect(ctx.db.row('p1', 'u1')).toBeUndefined();
  });

  it('regenerating recovery codes needs a valid code and replaces the old set', async () => {
    const ctx = build();
    const { secret, recoveryCodes } = await enrolled(ctx);
    const { recoveryCodes: fresh } = await ctx.svc.regenerateRecoveryCodes('p1', 'u1', ctx.codeAt(secret));
    expect(fresh).toHaveLength(8);
    expect(ctx.db.row('p1', 'u1').recoveryCodeHashes).toEqual(fresh.map(hashRecoveryCode));
    expect(ctx.db.row('p1', 'u1').recoveryCodeHashes).not.toContain(hashRecoveryCode(recoveryCodes[0]));
  });

  it('an administrator can require enrollment before any factor exists, and status reports it', async () => {
    const ctx = build();
    await ctx.svc.setEnrollmentRequired('p1', 'u9', true);
    expect(await ctx.svc.status('p1', 'u9')).toEqual({
      enrolled: false,
      enrollmentRequired: true,
      recoveryCodesLeft: 0,
      verifiedAt: null,
    });
    expect(ctx.db.row('p1', 'u9').totpSecretEnc).toBeNull();
    await ctx.svc.setEnrollmentRequired('p1', 'u9', false);
    expect((await ctx.svc.status('p1', 'u9')).enrollmentRequired).toBe(false);
  });

  it('lists only confirmed factors for the dashboard', async () => {
    const ctx = build();
    await enrolled(ctx);
    await ctx.svc.beginEnrollment('p1', 'u2', { issuer: 'Shop', account: 'b' });
    const list = await ctx.svc.listEnrolled('p1');
    expect(list.map((r) => r.keycloakUserId)).toEqual(['u1']);
    expect(list[0].recoveryCodesLeft).toBe(8);
  });

  it('too many wrong codes on the self-service routes are refused for a while', async () => {
    const ctx = build();
    const { secret } = await enrolled(ctx);
    const wrong = ctx.codeAt(secret) === '000000' ? '000001' : '000000';
    for (let i = 0; i < 10; i++) {
      await ctx.svc.disable('p1', 'u1', { code: wrong }).catch(() => undefined);
    }
    const err = await ctx.svc.disable('p1', 'u1', { code: ctx.codeAt(secret) }).catch((e) => e);
    expect(code(err)).toBe('too_many_attempts');
  });
});
