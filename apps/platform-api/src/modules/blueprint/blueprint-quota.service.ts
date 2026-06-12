import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/** Hard limits per plan tier (V1 — static config). */
const PLAN_LIMITS = {
  free: { analyzesPerMonth: 3, generationsPerMonth: 1, tablesPerBlueprint: 5 },
  pro: { analyzesPerMonth: 20, generationsPerMonth: 10, tablesPerBlueprint: 20 },
  business: { analyzesPerMonth: 100, generationsPerMonth: 50, tablesPerBlueprint: 50 },
  enterprise: { analyzesPerMonth: Infinity, generationsPerMonth: Infinity, tablesPerBlueprint: 100 },
} as const;

type PlanTier = keyof typeof PLAN_LIMITS;

@Injectable()
export class BlueprintQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlanTier(teamId: string): Promise<PlanTier> {
    // Try to read from Team.plan or a billing table
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { plan: true } as any,
    }).catch(() => null);
    const plan = (team as any)?.plan ?? 'free';
    return (plan in PLAN_LIMITS ? plan : 'free') as PlanTier;
  }

  async assertCanAnalyze(teamId: string): Promise<void> {
    const tier = await this.getPlanTier(teamId);
    const limit = PLAN_LIMITS[tier].analyzesPerMonth;
    if (limit === Infinity) return;

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const count = await (this.prisma as any).blueprint.count({
      where: {
        teamId,
        createdAt: { gte: startOfMonth },
      },
    }).catch(() => 0);

    if (count >= limit) {
      throw new ForbiddenException(
        `Blueprint analyze limit reached for your ${tier} plan (${limit}/month). Upgrade to continue.`,
      );
    }
  }

  async assertCanGenerate(teamId: string): Promise<void> {
    const tier = await this.getPlanTier(teamId);
    const limit = PLAN_LIMITS[tier].generationsPerMonth;
    if (limit === Infinity) return;

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const count = await (this.prisma as any).blueprint.count({
      where: {
        teamId,
        status: { in: ['generated', 'generating', 'queued'] },
        updatedAt: { gte: startOfMonth },
      },
    }).catch(() => 0);

    if (count >= limit) {
      throw new ForbiddenException(
        `Blueprint generation limit reached for your ${tier} plan (${limit}/month). Upgrade to continue.`,
      );
    }
  }

  getLimits(tier: PlanTier) {
    return PLAN_LIMITS[tier];
  }
}
