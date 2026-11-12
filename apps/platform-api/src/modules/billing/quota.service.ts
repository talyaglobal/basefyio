import {
  Injectable,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { UsageService } from './usage.service';
import { formatBinaryBytes } from './plan-limits';

export class QuotaExceededException extends HttpException {
  constructor(message: string, public readonly resource: string) {
    super(
      { statusCode: HttpStatus.PAYMENT_REQUIRED, message, resource, error: 'Quota Exceeded' },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * A project slot taken between the quota check and the moment the new project
 * row exists. Release it as soon as the row is written (it then counts itself)
 * or when the creation fails; releasing twice is harmless.
 */
export interface ProjectSlotReservation {
  release(): Promise<void>;
}

/**
 * How long an unreleased reservation holds a slot. Long enough for the
 * slowest provisioning (a dedicated container plus an auth realm), short
 * enough that a crashed creation frees the slot on its own.
 */
const PROJECT_SLOT_TTL_MS = 10 * 60 * 1000;

export interface TeamLimitSummary {
  plan: { name: string; displayName: string };
  projects: { used: number; limit: number | null; canCreate: boolean };
  members: { used: number; limit: number | null; canInvite: boolean };
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly redis: RedisService,
  ) {}

  private async getTeamPlanAndUsage(teamId: string) {
    let sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      include: { plan: true },
    });

    if (!sub) {
      const freePlan = await this.prisma.plan.findUnique({
        where: { name: 'free' },
      });

      if (!freePlan) {
        throw new ForbiddenException('Team has no subscription (free plan is not initialized)');
      }

      sub = await this.prisma.subscription.create({
        data: {
          teamId,
          planId: freePlan.id,
          status: 'ACTIVE',
        },
        include: { plan: true },
      });

      await this.prisma.teamUsage.upsert({
        where: { teamId },
        update: {},
        create: {
          teamId,
          projectCount: 0,
          storageBytes: BigInt(0),
          memberCount: 1,
          dbSizeBytes: BigInt(0),
          apiRequestsMonth: 0,
          bandwidthMonth: BigInt(0),
          mauCount: 0,
        },
      });
    }

    const currentUsage = await this.usage.getTeamUsage(teamId);
    return { plan: sub.plan, usage: currentUsage, subscription: sub };
  }

  private projectLimitMessage(maxProjects: number, planDisplayName: string): string {
    return `You have reached the maximum of ${maxProjects} projects on the ${planDisplayName} plan. Please upgrade to create more projects.`;
  }

  /**
   * Refuse a new project once the team's plan limit is reached.
   *
   * Counts the team's projects live (see UsageService.getTeamUsage). Creating a
   * project should go through {@link reserveProjectSlot}, which adds the guard
   * against two creations racing for the last slot.
   */
  async assertCanCreateProject(teamId: string): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxProjects !== null && usage.projectCount >= plan.maxProjects) {
      throw new QuotaExceededException(
        this.projectLimitMessage(plan.maxProjects, plan.displayName),
        'projects',
      );
    }
  }

  private slotKey(teamId: string): string {
    return `quota:project-slots:${teamId}`;
  }

  /**
   * Check the project limit and hold one slot until the new project row exists.
   *
   * The check and the row are seconds apart — a database, a user and an auth
   * realm are provisioned in between — and the old check read a counter only
   * bumped at the very end, so two creations started together (a double
   * submit, two imports at once) both saw a free slot. Each creation now
   * enters a per-team queue ordered by arrival; it may proceed only if the
   * projects that exist plus the creations queued ahead of it, itself
   * included, stay within the plan.
   *
   * If Redis is unavailable the live count is still enforced; only the race
   * guard is lost, and that is logged.
   */
  async reserveProjectSlot(teamId: string): Promise<ProjectSlotReservation> {
    const { plan } = await this.getTeamPlanAndUsage(teamId);
    if (plan.maxProjects === null) return { release: async () => {} };
    const maxProjects = plan.maxProjects;

    const key = this.slotKey(teamId);
    const token = `${Date.now()}:${randomUUID()}`;
    let client: ReturnType<RedisService['getClient']> | null = null;
    let ahead = 0;
    try {
      client = this.redis.getClient();
      const now = Date.now();
      await client.zremrangebyscore(key, 0, now - PROJECT_SLOT_TTL_MS);
      await client.zadd(key, now, token);
      await client.pexpire(key, PROJECT_SLOT_TTL_MS);
      const rank = await client.zrank(key, token);
      ahead = rank ?? 0;
    } catch (err: any) {
      this.logger.warn(`Project slot reservation unavailable for team ${teamId}: ${err.message}`);
      client = null;
    }

    let released = false;
    const release = async () => {
      if (released || !client) return;
      released = true;
      await client.zrem(key, token).catch(() => undefined);
    };

    try {
      const existing = await this.usage.countActiveProjects(teamId);
      // `ahead` creations are queued before this one; +1 is this one.
      if (existing + ahead + 1 > maxProjects) {
        throw new QuotaExceededException(this.projectLimitMessage(maxProjects, plan.displayName), 'projects');
      }
    } catch (err) {
      await release();
      throw err;
    }
    return { release };
  }

  /** Plan limits next to live usage, for the dashboard to warn before a 402. */
  async getTeamLimitSummary(teamId: string): Promise<TeamLimitSummary> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);
    return {
      plan: { name: plan.name, displayName: plan.displayName },
      projects: {
        used: usage.projectCount,
        limit: plan.maxProjects,
        canCreate: plan.maxProjects === null || usage.projectCount < plan.maxProjects,
      },
      members: {
        used: usage.memberCount,
        limit: plan.maxTeamMembers,
        canInvite: plan.maxTeamMembers === null || usage.memberCount < plan.maxTeamMembers,
      },
    };
  }

  async assertCanUploadStorage(teamId: string, additionalBytes: number): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxStorageBytes !== null) {
      const newTotal = usage.storageBytes + BigInt(additionalBytes);
      if (newTotal > plan.maxStorageBytes) {
        throw new QuotaExceededException(
          `Storage limit exceeded. Your ${plan.displayName} plan allows ${formatBinaryBytes(plan.maxStorageBytes)} of storage. Please upgrade for more storage.`,
          'storage',
        );
      }
    }
  }

  async assertCanInviteMember(teamId: string): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxTeamMembers !== null && usage.memberCount >= plan.maxTeamMembers) {
      throw new QuotaExceededException(
        `You have reached the maximum of ${plan.maxTeamMembers} team members on the ${plan.displayName} plan. Please upgrade to invite more members.`,
        'team_members',
      );
    }
  }

  async assertCanMakeApiRequest(teamId: string): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxApiRequests !== null && usage.apiRequestsMonth >= plan.maxApiRequests) {
      throw new QuotaExceededException(
        `API request limit reached. Your ${plan.displayName} plan allows ${plan.maxApiRequests.toLocaleString('en-US')} requests per month. Please upgrade for higher limits.`,
        'api_requests',
      );
    }
  }

  async assertCanUseBandwidth(teamId: string, bytes: number): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxBandwidthBytes !== null) {
      const newTotal = usage.bandwidthMonth + BigInt(bytes);
      if (newTotal > plan.maxBandwidthBytes) {
        throw new QuotaExceededException(
          `Bandwidth limit reached. Your ${plan.displayName} plan allows ${formatBinaryBytes(plan.maxBandwidthBytes)} per month. Please upgrade for more bandwidth.`,
          'bandwidth',
        );
      }
    }
  }

  async shouldUseDedicatedDb(teamId: string): Promise<boolean> {
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      include: { plan: true },
    });
    return sub?.plan?.dedicatedDb ?? false;
  }

  async shouldUseDedicatedStorage(teamId: string): Promise<boolean> {
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      include: { plan: true },
    });
    return sub?.plan?.dedicatedStorage ?? false;
  }

  async getTeamPlan(teamId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      include: { plan: true },
    });
    return sub?.plan ?? null;
  }
}
