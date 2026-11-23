import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementKey } from './entitlement-key';

/**
 * Plan-scoped feature gating. Resolves project → team → active subscription →
 * plan → `features` JSON. Default-allow: a feature is permitted unless the
 * plan explicitly sets it to `false`, so introducing this never breaks an
 * existing project/plan.
 */
/** Plans that include the AI assistant, lowest first. Anything above Pro belongs here too. */
export const AI_PLAN_NAMES = ['pro', 'business', 'enterprise'];
export const AI_PLAN_MESSAGE = 'The basefyio AI assistant is available on the Pro plan and above. Upgrade your team plan under Billing to use it.';

@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  private async planFeatures(projectId: string): Promise<Record<string, boolean> | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) return null;
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId: project.teamId },
      select: { plan: { select: { features: true } } },
    });
    const features = sub?.plan?.features;
    return features && typeof features === 'object' ? (features as Record<string, boolean>) : {};
  }

  /** True unless the plan explicitly disables the feature. */
  async can(projectId: string, key: EntitlementKey): Promise<boolean> {
    const features = await this.planFeatures(projectId);
    if (features === null) return false; // unknown project
    return features[key] !== false;
  }

  /** Throws 404 if the project is unknown, 403 if the plan disables the feature. */
  async assertCan(projectId: string, key: EntitlementKey): Promise<void> {
    const features = await this.planFeatures(projectId);
    if (features === null) throw new NotFoundException('Project not found');
    if (features[key] === false) {
      throw new ForbiddenException(`Your plan does not include this feature (${key})`);
    }
  }

  /**
   * The basefyio AI assistant calls a paid model, so it is opt-in by plan
   * rather than default-allow: Pro and above, or a plan whose `features`
   * sets `ai: true`. `ai: false` switches it off on any plan. A team
   * without a subscription row counts as Free.
   */
  async teamCanUseAi(teamId: string | null | undefined): Promise<boolean> {
    if (!teamId) return false;
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      select: { plan: { select: { name: true, features: true } } },
    });
    const plan = sub?.plan;
    if (!plan) return false;
    const features = plan.features && typeof plan.features === 'object' ? (plan.features as Record<string, unknown>) : {};
    if (features.ai === false) return false;
    if (features.ai === true) return true;
    // An Enterprise plan under another name (features.enterprise) is above Pro too.
    if (features.enterprise === true) return true;
    return AI_PLAN_NAMES.includes(plan.name.toLowerCase());
  }

  /** Throws 403 with an upgrade message when the team's plan does not include the AI assistant. */
  async assertTeamCanUseAi(teamId: string | null | undefined): Promise<void> {
    if (!(await this.teamCanUseAi(teamId))) {
      throw new ForbiddenException(AI_PLAN_MESSAGE);
    }
  }

  /** All entitlement keys with their effective allowed state (for UI). */
  async resolve(projectId: string): Promise<Record<string, boolean>> {
    const features = (await this.planFeatures(projectId)) ?? {};
    const out: Record<string, boolean> = {};
    for (const key of Object.values(EntitlementKey)) {
      out[key] = features[key] !== false;
    }
    return out;
  }
}
