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
