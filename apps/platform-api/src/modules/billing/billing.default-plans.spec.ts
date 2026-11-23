import { BadRequestException } from '@nestjs/common';
import { BillingService } from './billing.service';
import { ALL_DEFAULT_PLANS, DEFAULT_PLANS, ENTERPRISE_PLAN } from './default-plans';
import { isCardExempt, isEnterprisePlan, isGrandfatheredPlan, planRequiresCard } from './billing-plan-rules';

function makeService(planCount: number, opts: { enterpriseExists?: boolean; marker?: boolean } = {}) {
  const prisma = {
    plan: {
      count: jest.fn().mockResolvedValue(planCount),
      createMany: jest.fn().mockResolvedValue({ count: DEFAULT_PLANS.length }),
      findUnique: jest.fn().mockResolvedValue(opts.enterpriseExists ? { id: 'ent' } : null),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    systemSetting: {
      findUnique: jest.fn().mockResolvedValue(opts.marker ? { key: 'plans.enterprise_seeded' } : null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const stripe = { isEnabled: () => false };
  const service = new BillingService(prisma as any, stripe as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { service, prisma };
}

describe('BillingService default plans', () => {
  it('writes the default plans when the plans table is empty', async () => {
    const { service, prisma } = makeService(0);
    await service.onModuleInit();
    expect(prisma.plan.createMany).toHaveBeenCalledWith({ data: DEFAULT_PLANS, skipDuplicates: true });
    expect(DEFAULT_PLANS.map((p) => p.name)).toEqual(['legacy', 'free', 'pro', 'business']);
  });

  it('never touches an installation that has plans', async () => {
    const { service, prisma } = makeService(4, { enterpriseExists: true });
    await service.onModuleInit();
    expect(prisma.plan.createMany).not.toHaveBeenCalled();
    expect(prisma.plan.update).not.toHaveBeenCalled();
    expect(prisma.plan.upsert).not.toHaveBeenCalled();
  });

  it('does not fail the boot when the write fails', async () => {
    const { service, prisma } = makeService(0);
    prisma.plan.createMany.mockRejectedValue(new Error('db down'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('Enterprise plan', () => {
  it('is not public, has no Stripe price, no caps, and is marked enterprise', () => {
    expect(ENTERPRISE_PLAN).toMatchObject({
      name: 'enterprise',
      isPublic: false,
      priceMonthly: 0,
      stripePriceId: null,
      stripeProductId: null,
      maxProjects: null,
      maxDbSizeBytes: null,
      maxApiRequests: null,
      maxBandwidthBytes: null,
      maxMau: null,
    });
    expect((ENTERPRISE_PLAN.features as any).enterprise).toBe(true);
    expect(ALL_DEFAULT_PLANS.map((p) => p.name)).toEqual(['legacy', 'free', 'pro', 'business', 'enterprise']);
  });

  it('is added to an installation that has plans but no Enterprise row, and the marker is written', async () => {
    const { service, prisma } = makeService(4);
    await service.onModuleInit();
    expect(prisma.plan.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.plan.createMany).toHaveBeenCalledWith({ data: [ENTERPRISE_PLAN], skipDuplicates: true });
    expect(prisma.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'plans.enterprise_seeded' }, update: {} }),
    );
  });

  it('is never written when a row named enterprise exists (live rows are not overwritten)', async () => {
    const { service, prisma } = makeService(5, { enterpriseExists: true });
    await service.onModuleInit();
    expect(prisma.plan.createMany).not.toHaveBeenCalled();
    expect(prisma.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it('is not re-created after a root deleted it on purpose (marker present)', async () => {
    const { service, prisma } = makeService(4, { marker: true });
    await service.onModuleInit();
    expect(prisma.plan.createMany).not.toHaveBeenCalled();
  });

  it('counts as enterprise by name or by features, and is neither grandfathered nor card-bound', () => {
    expect(isEnterprisePlan({ name: 'enterprise' })).toBe(true);
    expect(isEnterprisePlan({ name: 'acme-contract', features: { enterprise: true } })).toBe(true);
    expect(isEnterprisePlan({ name: 'business', features: { prioritySupport: true } })).toBe(false);
    const ent = { name: 'enterprise', priceMonthly: 0, features: { enterprise: true } };
    expect(isGrandfatheredPlan(ent)).toBe(false);
    expect(isCardExempt(ent)).toBe(false);
    expect(planRequiresCard(ent)).toBe(false);
    expect(isGrandfatheredPlan({ name: 'legacy' })).toBe(true);
    expect(isGrandfatheredPlan({ name: 'old-pro', features: { grandfathered: true } })).toBe(true);
  });
});

describe('Enterprise is never self-serve', () => {
  function serviceWithPlan(plan: any) {
    const prisma = {
      plan: { findUnique: jest.fn().mockResolvedValue(plan) },
      subscription: { findUnique: jest.fn() },
    };
    const service = new BillingService(prisma as any, { isEnabled: () => true } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    (service as any).assertTeamOwner = jest.fn().mockResolvedValue(undefined);
    return { service, prisma };
  }
  const enterprise = { id: 'p-ent', name: 'enterprise', displayName: 'Enterprise', priceMonthly: 0, features: { enterprise: true } };

  it('refuses a plan change to Enterprise before touching the subscription or the card', async () => {
    const { service, prisma } = serviceWithPlan(enterprise);
    await expect(service.changePlan('t1', 'u1', 'enterprise')).rejects.toThrow(BadRequestException);
    await expect(service.changePlan('t1', 'u1', 'enterprise')).rejects.toThrow(/arranged with our team/);
    expect(prisma.subscription.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a preview and a checkout for Enterprise', async () => {
    const { service } = serviceWithPlan(enterprise);
    await expect(service.previewPlanChange('t1', 'u1', 'enterprise')).rejects.toThrow(/arranged with our team/);
    await expect(service.createCheckoutSession('t1', 'u1', 'enterprise', 'https://a', 'https://b')).rejects.toThrow(
      /arranged with our team/,
    );
  });

  it('still lets a public paid plan through the same check', async () => {
    const { service, prisma } = serviceWithPlan({ id: 'p-pro', name: 'pro', priceMonthly: 2000, stripePriceId: 'price_x', features: null });
    prisma.subscription.findUnique.mockResolvedValue(null);
    await expect(service.changePlan('t1', 'u1', 'pro')).rejects.toThrow(/No active subscription/);
  });
});
