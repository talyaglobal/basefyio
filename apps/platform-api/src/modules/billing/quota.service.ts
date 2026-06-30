import {
  Injectable,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageService } from './usage.service';

export class QuotaExceededException extends HttpException {
  constructor(message: string, public readonly resource: string) {
    super(
      { statusCode: HttpStatus.PAYMENT_REQUIRED, message, resource, error: 'Quota Exceeded' },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

@Injectable()
export class QuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
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

  async assertCanCreateProject(teamId: string): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxProjects !== null && usage && usage.projectCount >= plan.maxProjects) {
      throw new QuotaExceededException(
        `You have reached the maximum of ${plan.maxProjects} projects on the ${plan.displayName} plan. Please upgrade to create more projects.`,
        'projects',
      );
    }
  }

  async assertCanUploadStorage(teamId: string, additionalBytes: number): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxStorageBytes !== null && usage) {
      const newTotal = usage.storageBytes + BigInt(additionalBytes);
      if (newTotal > plan.maxStorageBytes) {
        const limitMb = Number(plan.maxStorageBytes) / (1024 * 1024);
        throw new QuotaExceededException(
          `Storage limit exceeded. Your ${plan.displayName} plan allows ${limitMb >= 1024 ? `${(limitMb / 1024).toFixed(0)} GB` : `${limitMb} MB`} of storage. Please upgrade for more storage.`,
          'storage',
        );
      }
    }
  }

  async assertCanInviteMember(teamId: string): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxTeamMembers !== null && usage && usage.memberCount >= plan.maxTeamMembers) {
      throw new QuotaExceededException(
        `You have reached the maximum of ${plan.maxTeamMembers} team members on the ${plan.displayName} plan. Please upgrade to invite more members.`,
        'team_members',
      );
    }
  }

  async assertCanMakeApiRequest(teamId: string): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxApiRequests !== null && usage && usage.apiRequestsMonth >= plan.maxApiRequests) {
      throw new QuotaExceededException(
        `API request limit reached. Your ${plan.displayName} plan allows ${plan.maxApiRequests.toLocaleString()} requests per month. Please upgrade for higher limits.`,
        'api_requests',
      );
    }
  }

  async assertCanUseBandwidth(teamId: string, bytes: number): Promise<void> {
    const { plan, usage } = await this.getTeamPlanAndUsage(teamId);

    if (plan.maxBandwidthBytes !== null && usage) {
      const newTotal = usage.bandwidthMonth + BigInt(bytes);
      if (newTotal > plan.maxBandwidthBytes) {
        const limitGb = Number(plan.maxBandwidthBytes) / (1024 * 1024 * 1024);
        throw new QuotaExceededException(
          `Bandwidth limit reached. Your ${plan.displayName} plan allows ${limitGb} GB per month. Please upgrade for more bandwidth.`,
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
