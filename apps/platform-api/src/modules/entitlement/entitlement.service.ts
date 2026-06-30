import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementKey } from './entitlement-key';

/**
 * Plan-scoped feature gating. Resolves project → team → active subscription →
 * plan → `features` JSON. Default-allow: a feature is permitted unless the
 * plan explicitly sets it to `false`, so introducing this never breaks an
 * existing project/plan.
 */
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
