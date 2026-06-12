import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EntitlementKey } from './entitlement-key';

@Injectable()
export class EntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns true only if:
   *   1. The project exists.
   *   2. The team has an ACTIVE subscription.
   *   3. Plan.features[key] === true.
   *
   * Returns false (never throws) on any missing link — callers use assertCan() to throw.
   */
  async can(projectId: string, key: EntitlementKey): Promise<boolean> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) return false;

    const sub = await this.prisma.subscription.findUnique({
      where: { teamId: project.teamId },
      select: { status: true, plan: { select: { features: true } } },
    });
    if (!sub || sub.status !== 'ACTIVE') return false;

    const features = (sub.plan.features ?? {}) as Record<string, boolean>;
    return features[key] === true;
  }

  /**
   * Throws ForbiddenException when the plan does not include the key.
   * Throws NotFoundException when the project itself does not exist.
   */
  async assertCan(projectId: string, key: EntitlementKey): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const sub = await this.prisma.subscription.findUnique({
      where: { teamId: project.teamId },
      select: { status: true, plan: { select: { features: true } } },
    });
    if (!sub || sub.status !== 'ACTIVE') {
      throw new ForbiddenException('No active subscription for this project');
    }

    const features = (sub.plan.features ?? {}) as Record<string, boolean>;
    if (features[key] !== true) {
      throw new ForbiddenException(`Plan does not include feature: ${key}`);
    }
  }

  /** Resolve all enabled entitlement keys for a project (for connection info display). */
  async resolve(projectId: string): Promise<Partial<Record<EntitlementKey, boolean>>> {
    const result: Partial<Record<EntitlementKey, boolean>> = {};
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) return result;

    const sub = await this.prisma.subscription.findUnique({
      where: { teamId: project.teamId },
      select: { status: true, plan: { select: { features: true } } },
    });
    if (!sub || sub.status !== 'ACTIVE') return result;

    const features = (sub.plan.features ?? {}) as Record<string, boolean>;
    for (const key of Object.values(EntitlementKey)) {
      result[key] = features[key] === true;
    }
    return result;
  }
}
