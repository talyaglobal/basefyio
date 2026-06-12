import { BlueprintQuotaService } from './blueprint-quota.service';
import { ForbiddenException } from '@nestjs/common';

function makePrisma(planOverride?: string, countOverride = 0) {
  return {
    team: {
      findUnique: jest.fn().mockResolvedValue({ id: 't-1', plan: planOverride ?? 'free' }),
    },
    blueprint: {
      count: jest.fn().mockResolvedValue(countOverride),
    },
  };
}

describe('BlueprintQuotaService', () => {
  it('allows analyze when under limit', async () => {
    const prisma = makePrisma('free', 2); // limit is 3
    const svc = new BlueprintQuotaService(prisma as any);
    await expect(svc.assertCanAnalyze('t-1')).resolves.toBeUndefined();
  });

  it('throws ForbiddenException when free analyze limit reached', async () => {
    const prisma = makePrisma('free', 3); // limit is 3, already at 3
    const svc = new BlueprintQuotaService(prisma as any);
    await expect(svc.assertCanAnalyze('t-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows unlimited analyzes on enterprise plan', async () => {
    const prisma = makePrisma('enterprise', 9999);
    const svc = new BlueprintQuotaService(prisma as any);
    await expect(svc.assertCanAnalyze('t-1')).resolves.toBeUndefined();
  });

  it('allows generate when under limit', async () => {
    const prisma = makePrisma('pro', 5); // limit is 10
    const svc = new BlueprintQuotaService(prisma as any);
    await expect(svc.assertCanGenerate('t-1')).resolves.toBeUndefined();
  });

  it('throws ForbiddenException when pro generate limit reached', async () => {
    const prisma = makePrisma('pro', 10); // limit is 10
    const svc = new BlueprintQuotaService(prisma as any);
    await expect(svc.assertCanGenerate('t-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getLimits returns correct limits for business plan', () => {
    const svc = new BlueprintQuotaService({} as any);
    const limits = svc.getLimits('business');
    expect(limits.analyzesPerMonth).toBe(100);
    expect(limits.tablesPerBlueprint).toBe(50);
  });
});
