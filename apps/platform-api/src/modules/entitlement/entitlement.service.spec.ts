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
