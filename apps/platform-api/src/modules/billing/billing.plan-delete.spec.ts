import { BadRequestException } from '@nestjs/common';
import { BillingService } from './billing.service';

function makeService(teams: number, name = 'pro') {
  const prisma = {
    plan: {
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', name }),
      delete: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([{ id: 'p1', name, _count: { subscriptions: teams } }]),
    },
    subscription: { count: jest.fn().mockResolvedValue(teams) },
  };
  const service = new BillingService(prisma as any, { isEnabled: () => false } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { service, prisma };
}

describe('BillingService plan deletion', () => {
  it('refuses a plan that teams are on and deletes nothing', async () => {
    const { service, prisma } = makeService(4);
    await expect(service.deleteManagementPlan('pro')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.plan.delete).not.toHaveBeenCalled();
  });

  it('deletes an unused plan', async () => {
    const { service, prisma } = makeService(0);
    await expect(service.deleteManagementPlan('pro')).resolves.toEqual({ deletedPlan: 'pro' });
    expect(prisma.plan.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
  });

  it('never deletes the free plan', async () => {
    const { service } = makeService(0, 'free');
    await expect(service.deleteManagementPlan('free')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists plans with the number of teams on each', async () => {
    const { service } = makeService(4);
    expect(await service.listManagementPlans()).toEqual([{ id: 'p1', name: 'pro', subscriptionCount: 4 }]);
  });
});
