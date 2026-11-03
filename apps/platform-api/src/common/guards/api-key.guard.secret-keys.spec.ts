import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { hashSecretKey } from '../utils/secret-keys';

function makeCtx(headers: Record<string, unknown>, query: Record<string, unknown> = {}) {
  const req: any = { headers, query };
  const context: any = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
  return { context, req };
}

const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as any;
const config = { get: jest.fn().mockReturnValue(undefined) } as any;

const PROJECT = {
  id: 'p1',
  anonKey: 'bf_anon_a',
  serviceKey: 'bf_service_s',
  serviceKeyLastUsedAt: null as Date | null,
  keycloakRealm: 'realm1',
  status: 'ACTIVE',
};
const SECRET = 'bf_secret_' + 'x'.repeat(43);

function prismaWith(opts: { revoked?: boolean; lastUsedAt?: Date | null; serviceLastUsedAt?: Date | null } = {}) {
  const project = { ...PROJECT, serviceKeyLastUsedAt: opts.serviceLastUsedAt ?? null };
  return {
    project: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.OR.some((o: any) => o.anonKey === project.anonKey || o.serviceKey === project.serviceKey) &&
        where.OR.some((o: any) => Object.values(o)[0] === project.anonKey || Object.values(o)[0] === project.serviceKey)
          ? project
          : null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    projectSecretKey: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.keyHash === hashSecretKey(SECRET)
          ? { id: 'k1', lastUsedAt: opts.lastUsedAt ?? null, revokedAt: opts.revoked ? new Date() : null, project }
          : null,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('ApiKeyGuard with secret keys', () => {
  it('admits a secret key with service_role rights, looked up by its hash only', async () => {
    const prisma = prismaWith();
    const g = new ApiKeyGuard(prisma, config, reflector);
    const { context, req } = makeCtx({ apikey: SECRET });
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload).toMatchObject({ projectId: 'p1', role: 'service', dbRole: 'service_role' });
    expect(prisma.projectSecretKey.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { keyHash: hashSecretKey(SECRET) } }),
    );
    expect(JSON.stringify(prisma.projectSecretKey.findUnique.mock.calls)).not.toContain(SECRET);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a revoked secret key on the very next request', async () => {
    const g = new ApiKeyGuard(prismaWith({ revoked: true }), config, reflector);
    await expect(g.canActivate(makeCtx({ apikey: SECRET }).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an unknown secret key', async () => {
    const g = new ApiKeyGuard(prismaWith(), config, reflector);
    await expect(g.canActivate(makeCtx({ apikey: 'bf_secret_unknown' }).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('keeps a secret key out of the query string, like the service key', async () => {
    const g = new ApiKeyGuard(prismaWith(), config, reflector);
    await expect(g.canActivate(makeCtx({}, { apikey: SECRET }).context)).rejects.toThrow(/apikey header/);
  });

  it('records when a secret key was used, at most every five minutes', async () => {
    const fresh = prismaWith({ lastUsedAt: new Date() });
    await new ApiKeyGuard(fresh, config, reflector).canActivate(makeCtx({ apikey: SECRET }).context);
    expect(fresh.projectSecretKey.update).not.toHaveBeenCalled();

    const stale = prismaWith({ lastUsedAt: new Date(Date.now() - 6 * 60_000) });
    await new ApiKeyGuard(stale, config, reflector).canActivate(makeCtx({ apikey: SECRET }).context);
    expect(stale.projectSecretKey.update).toHaveBeenCalledWith({ where: { id: 'k1' }, data: { lastUsedAt: expect.any(Date) } });
  });

  it('records the first use of the service key, which is what hides it in the dashboard', async () => {
    const prisma = prismaWith();
    await new ApiKeyGuard(prisma, config, reflector).canActivate(makeCtx({ apikey: 'bf_service_s' }).context);
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { serviceKeyLastUsedAt: expect.any(Date) } });
  });

  it('never records anything for the anon key', async () => {
    const prisma = prismaWith();
    await new ApiKeyGuard(prisma, config, reflector).canActivate(makeCtx({ apikey: 'bf_anon_a' }).context);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('a failing bookkeeping write never fails the request', async () => {
    const prisma = prismaWith();
    prisma.project.update.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(
      new ApiKeyGuard(prisma, config, reflector).canActivate(makeCtx({ apikey: 'bf_service_s' }).context),
    ).resolves.toBe(true);
  });
});
