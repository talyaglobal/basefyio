import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { EntitlementKey } from './entitlement-key';

/** Minimal PrismaService stub returning canned project/subscription rows. */
function makePrisma(project: any, sub: any) {
  return {
    project: { findUnique: jest.fn().mockResolvedValue(project) },
    subscription: { findUnique: jest.fn().mockResolvedValue(sub) },
  } as any;
}

const withFeatures = (features: any) => ({ plan: { features } });

describe('EntitlementService', () => {
  it('default-allows when the plan has no features map', async () => {
    const svc = new EntitlementService(makePrisma({ teamId: 't1' }, withFeatures(null)));
    await expect(svc.can('p1', EntitlementKey.FLOWS)).resolves.toBe(true);
    await expect(svc.assertCan('p1', EntitlementKey.FLOWS)).resolves.toBeUndefined();
  });

  it('allows a feature unless explicitly disabled', async () => {
    const svc = new EntitlementService(
      makePrisma({ teamId: 't1' }, withFeatures({ [EntitlementKey.FLOWS]: true })),
    );
    await expect(svc.can('p1', EntitlementKey.FLOWS)).resolves.toBe(true);
  });

  it('denies a feature explicitly set to false', async () => {
    const svc = new EntitlementService(
      makePrisma({ teamId: 't1' }, withFeatures({ [EntitlementKey.FLOWS]: false })),
    );
    await expect(svc.can('p1', EntitlementKey.FLOWS)).resolves.toBe(false);
    await expect(svc.assertCan('p1', EntitlementKey.FLOWS)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns false / throws NotFound for an unknown project', async () => {
    const svc = new EntitlementService(makePrisma(null, null));
    await expect(svc.can('missing', EntitlementKey.FLOWS)).resolves.toBe(false);
    await expect(svc.assertCan('missing', EntitlementKey.FLOWS)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('resolve() reports every key, honoring explicit disables', async () => {
    const svc = new EntitlementService(
      makePrisma({ teamId: 't1' }, withFeatures({ [EntitlementKey.SCHEMA_MIGRATIONS]: false })),
    );
    const map = await svc.resolve('p1');
    expect(map[EntitlementKey.SCHEMA_MIGRATIONS]).toBe(false);
    expect(map[EntitlementKey.FLOWS]).toBe(true);
    expect(Object.keys(map).sort()).toEqual(Object.values(EntitlementKey).sort());
  });
});

describe('EntitlementService — AI assistant (Pro and above)', () => {
  const plan = (name: string, features: any = null) => ({ plan: { name, features } });
  const svc = (sub: any) => new EntitlementService(makePrisma(null, sub));

  it.each([
    ['free', null, false],
    ['legacy', { grandfathered: true }, false],
    ['pro', { dailyBackups: true }, true],
    ['Business', null, true],
    ['enterprise', null, true],
    ['acme-contract', { enterprise: true }, true],
  ])('plan %s → %s', async (name, features, allowed) => {
    await expect(svc(plan(name as string, features)).teamCanUseAi('t1')).resolves.toBe(allowed);
  });

  it('lets a plan opt in with ai:true and switch off with ai:false', async () => {
    await expect(svc(plan('free', { ai: true })).teamCanUseAi('t1')).resolves.toBe(true);
    await expect(svc(plan('business', { ai: false })).teamCanUseAi('t1')).resolves.toBe(false);
  });

  it('refuses a team with no subscription or no team', async () => {
    await expect(svc(null).teamCanUseAi('t1')).resolves.toBe(false);
    await expect(svc(plan('pro')).teamCanUseAi(null)).resolves.toBe(false);
  });

  it('assert throws 403 with the upgrade message on Free', async () => {
    await expect(svc(plan('free')).assertTeamCanUseAi('t1')).rejects.toThrow(ForbiddenException);
    await expect(svc(plan('free')).assertTeamCanUseAi('t1')).rejects.toThrow(/Pro plan and above/);
    await expect(svc(plan('pro')).assertTeamCanUseAi('t1')).resolves.toBeUndefined();
  });
});

describe('EntitlementService — platform-key embeddings (Pro and above, legacy included)', () => {
  const plan = (name: string, features: any = null) => ({ plan: { name, features } });
  const svc = (sub: any) => new EntitlementService(makePrisma(null, sub));

  it.each([
    ['free', null, false],
    ['legacy', { grandfathered: true }, true],
    ['pro', null, true],
    ['Business', null, true],
    ['enterprise', { enterprise: true }, true],
    ['acme-contract', { enterprise: true }, true],
  ])('plan %s → %s', async (name, features, allowed) => {
    await expect(svc(plan(name as string, features)).teamCanUsePlatformEmbeddings('t1')).resolves.toBe(allowed);
  });

  it('features.embeddings overrides the plan name both ways', async () => {
    await expect(svc(plan('free', { embeddings: true })).teamCanUsePlatformEmbeddings('t1')).resolves.toBe(true);
    await expect(svc(plan('pro', { embeddings: false })).teamCanUsePlatformEmbeddings('t1')).resolves.toBe(false);
    await expect(svc(plan('acme', { enterprise: true, embeddings: false })).teamCanUsePlatformEmbeddings('t1')).resolves.toBe(false);
  });

  it('no subscription row or no team counts as Free', async () => {
    await expect(svc(null).teamCanUsePlatformEmbeddings('t1')).resolves.toBe(false);
    await expect(svc(plan('pro')).teamCanUsePlatformEmbeddings(null)).resolves.toBe(false);
  });

  it('assert throws 403 EMBEDDING_PLAN_REQUIRED with the upgrade / own-key message', async () => {
    const err: any = await svc(plan('free')).assertTeamCanUsePlatformEmbeddings('t1').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ statusCode: 403, code: 'EMBEDDING_PLAN_REQUIRED' });
    expect(err.getResponse().message).toMatch(/Pro plan and above.*own embedding provider key/);
    await expect(svc(plan('legacy')).assertTeamCanUsePlatformEmbeddings('t1')).resolves.toBeUndefined();
  });

  it('caches the lookup per team for 60 s, then reads the plan again', async () => {
    const prisma = makePrisma(null, plan('free'));
    const s = new EntitlementService(prisma);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      expect(await s.teamCanUsePlatformEmbeddings('t1')).toBe(false);
      prisma.subscription.findUnique.mockResolvedValue(plan('pro'));
      expect(await s.teamCanUsePlatformEmbeddings('t1')).toBe(false);
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 60_001);
      expect(await s.teamCanUsePlatformEmbeddings('t1')).toBe(true);
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('leaves the assistant rule alone: legacy still has no AI assistant', async () => {
    const s = svc(plan('legacy', { grandfathered: true }));
    await expect(s.teamCanUseAi('t1')).resolves.toBe(false);
    await expect(s.teamCanUsePlatformEmbeddings('t1')).resolves.toBe(true);
  });
});
