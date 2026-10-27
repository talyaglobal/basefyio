import { BillingService } from './billing.service';
import { DEFAULT_PLANS } from './default-plans';

function makeService(planCount: number) {
  const prisma = {
    plan: {
      count: jest.fn().mockResolvedValue(planCount),
      createMany: jest.fn().mockResolvedValue({ count: DEFAULT_PLANS.length }),
    },
  };
  const stripe = { isEnabled: () => false };
  const service = new BillingService(prisma as any, stripe as any, {} as any, {} as any, {} as any, {} as any);
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
    const { service, prisma } = makeService(4);
    await service.onModuleInit();
    expect(prisma.plan.createMany).not.toHaveBeenCalled();
  });

  it('does not fail the boot when the write fails', async () => {
    const { service, prisma } = makeService(0);
    prisma.plan.createMany.mockRejectedValue(new Error('db down'));
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
