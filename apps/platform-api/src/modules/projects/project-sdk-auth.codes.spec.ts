import { BadRequestException, HttpException } from '@nestjs/common';
import { createHash } from 'crypto';
import { ProjectSdkAuthService } from './project-sdk-auth.service';

/**
 * Reset and verification codes: a six-digit code alone used to
 * reset whichever account it belonged to, with no limit on guesses.
 */
const hash = (e: string) => createHash('sha256').update(e.trim().toLowerCase()).digest('hex').slice(0, 32);

function build(codes: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(codes).map(([k, v]) => [k, JSON.stringify(v)]));
  const redis = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    del: jest.fn(async (k: string) => void store.delete(k)),
    incr: jest.fn(async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => undefined),
  };
  const svc: any = Object.create(ProjectSdkAuthService.prototype);
  svc.redis = redis;
  svc.logger = { warn: jest.fn(), log: jest.fn() };
  svc.authConfig = { getOrCreate: jest.fn(async () => ({ minPasswordLength: 8 })) };
  svc.keycloak = {
    resetRealmUserPassword: jest.fn(async () => undefined),
    getRealmUserById: jest.fn(async () => ({ email: 'old@example.com' })),
    setEmailVerified: jest.fn(async () => undefined),
  };
  svc.getProject = jest.fn(async () => ({ id: 'p1', name: 'P' }));
  svc.sendEmail = jest.fn(async () => undefined);
  return { svc, store };
}

const CODE = { userId: 'u1', realmName: 'r', projectId: 'p1', emailHash: hash('ada@example.com') };

describe('reset-password codes', () => {
  it('resets with the right code and address, once', async () => {
    const { svc, store } = build({ 'reset_password:p1:123456': CODE });
    await svc.resetPassword('p1', '123456', 'new-password-1', 'Ada@Example.com');
    expect(svc.keycloak.resetRealmUserPassword).toHaveBeenCalledWith('r', 'u1', 'new-password-1');
    expect(store.has('reset_password:p1:123456')).toBe(false);
  });

  it('refuses a valid code sent with another address', async () => {
    const { svc } = build({ 'reset_password:p1:123456': CODE });
    await expect(svc.resetPassword('p1', '123456', 'new-password-1', 'eve@example.com')).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
  });

  it('ends after five wrong codes for an address, even if the sixth is right', async () => {
    const { svc } = build({ 'reset_password:p1:123456': CODE });
    for (let i = 0; i < 5; i++) {
      await expect(svc.resetPassword('p1', String(100000 + i), 'new-password-1', 'ada@example.com')).rejects.toBeInstanceOf(BadRequestException);
    }
    const sixth = svc.resetPassword('p1', '123456', 'new-password-1', 'ada@example.com');
    await expect(sixth).rejects.toBeInstanceOf(HttpException);
    await expect(sixth).rejects.toMatchObject({ status: 429 });
    expect(svc.keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
  });

  it('keeps the code-only path for older clients, closed after twenty wrong codes per project', async () => {
    const { svc } = build({ 'reset_password:p1:123456': CODE });
    for (let i = 0; i < 20; i++) {
      await expect(svc.resetPassword('p1', String(200000 + i), 'new-password-1')).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(svc.resetPassword('p1', '123456', 'new-password-1')).rejects.toMatchObject({ status: 429 });
    // The address path still works for the real owner.
    await svc.resetPassword('p1', '123456', 'new-password-1', 'ada@example.com');
    expect(svc.keycloak.resetRealmUserPassword).toHaveBeenCalledTimes(1);
  });

  it('accepts a code issued before addresses were recorded when the address is the user\'s', async () => {
    const { svc } = build({ 'reset_password:p1:654321': { userId: 'u1', realmName: 'r', projectId: 'p1' } });
    await expect(svc.resetPassword('p1', '654321', 'new-password-1', 'someone@example.com')).rejects.toBeInstanceOf(BadRequestException);
    await svc.resetPassword('p1', '654321', 'new-password-1', 'old@example.com');
    expect(svc.keycloak.resetRealmUserPassword).toHaveBeenCalledTimes(1);
  });
});

describe('verify-email codes', () => {
  it('binds the code to the address the same way', async () => {
    const { svc } = build({ 'verify_email:p1:111111': CODE });
    await expect(svc.verifyEmail('p1', '111111', 'eve@example.com')).rejects.toBeInstanceOf(BadRequestException);
    await svc.verifyEmail('p1', '111111', 'ada@example.com');
    expect(svc.keycloak.setEmailVerified).toHaveBeenCalledWith('r', 'u1');
  });
});

describe('magic-link codes', () => {
  it('needs the right address too', async () => {
    const { svc } = build({ 'magic_link:p1:222222': CODE });
    svc.keycloak.getRealmUserById = jest.fn(async () => ({ email: 'ada@example.com', emailVerified: true }));
    await expect(svc.verifyMagicLink('p1', '222222', 'eve@example.com')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.verifyMagicLink('p1', '222222', 'ada@example.com')).resolves.toMatchObject({ userId: 'u1' });
  });
});

