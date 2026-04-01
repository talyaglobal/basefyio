import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private apiRequestsKey(teamId: string): string {
    return `usage:api_requests:${teamId}`;
  }

  private bandwidthKey(teamId: string): string {
    return `usage:bandwidth:${teamId}`;
  }

  async trackApiRequest(teamId: string): Promise<void> {
    const key = this.apiRequestsKey(teamId);
    await this.redis.incr(key);
    await this.redis.expire(key, 35 * 24 * 60 * 60);
  }

  async trackBandwidth(teamId: string, bytes: number): Promise<void> {
    const key = this.bandwidthKey(teamId);
    await this.redis.incrby(key, bytes);
    await this.redis.expire(key, 35 * 24 * 60 * 60);
  }

  async getTeamUsage(teamId: string) {
    const usage = await this.prisma.teamUsage.findUnique({
      where: { teamId },
    });

    if (!usage) return null;

    const [apiReqs, bw] = await Promise.all([
      this.redis.get(this.apiRequestsKey(teamId)),
      this.redis.get(this.bandwidthKey(teamId)),
    ]);

    return {
      ...usage,
      apiRequestsMonth: usage.apiRequestsMonth + parseInt(apiReqs || '0', 10),
      bandwidthMonth: usage.bandwidthMonth + BigInt(bw || '0'),
    };
  }

  async recalculateTeamUsage(teamId: string): Promise<void> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        projects: {
          where: { status: { not: 'DELETED' } },
          select: { id: true, slug: true },
        },
        members: { select: { id: true } },
      },
    });

    if (!team) return;

    const projectCount = team.projects.length;
    const memberCount = team.members.length;

    const apiReqs = await this.redis.getdel(this.apiRequestsKey(teamId));
    const bw = await this.redis.getdel(this.bandwidthKey(teamId));

    await this.prisma.teamUsage.upsert({
      where: { teamId },
      update: {
        projectCount,
        memberCount,
        apiRequestsMonth: {
          increment: parseInt(apiReqs || '0', 10),
        },
        bandwidthMonth: {
          increment: BigInt(bw || '0'),
        },
        lastCalculatedAt: new Date(),
      },
      create: {
        teamId,
        projectCount,
        memberCount,
        storageBytes: BigInt(0),
        dbSizeBytes: BigInt(0),
        apiRequestsMonth: parseInt(apiReqs || '0', 10),
        bandwidthMonth: BigInt(bw || '0'),
        mauCount: 0,
      },
    });
  }

  async incrementProjectCount(teamId: string): Promise<void> {
    await this.prisma.teamUsage.update({
      where: { teamId },
      data: { projectCount: { increment: 1 } },
    });
  }

  async decrementProjectCount(teamId: string): Promise<void> {
    await this.prisma.teamUsage.update({
      where: { teamId },
      data: { projectCount: { decrement: 1 } },
    });
  }

  async incrementMemberCount(teamId: string): Promise<void> {
    await this.prisma.teamUsage.update({
      where: { teamId },
      data: { memberCount: { increment: 1 } },
    });
  }

  async decrementMemberCount(teamId: string): Promise<void> {
    await this.prisma.teamUsage.update({
      where: { teamId },
      data: { memberCount: { decrement: 1 } },
    });
  }

  @Cron('0 0 1 * *')
  async resetMonthlyCounters(): Promise<void> {
    this.logger.log('Resetting monthly usage counters...');

    const allUsage = await this.prisma.teamUsage.findMany();
    const now = new Date();
    const periodEnd = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    for (const usage of allUsage) {
      const apiReqs = await this.redis.getdel(this.apiRequestsKey(usage.teamId));
      const bw = await this.redis.getdel(this.bandwidthKey(usage.teamId));
      const totalApi = usage.apiRequestsMonth + parseInt(apiReqs || '0', 10);
      const totalBw = usage.bandwidthMonth + BigInt(bw || '0');

      const records = [
        { metric: 'api_requests', value: BigInt(totalApi) },
        { metric: 'bandwidth', value: totalBw },
        { metric: 'storage_bytes', value: usage.storageBytes },
        { metric: 'db_size_bytes', value: usage.dbSizeBytes },
        { metric: 'mau', value: BigInt(usage.mauCount) },
      ];

      for (const rec of records) {
        await this.prisma.usageRecord.create({
          data: {
            teamId: usage.teamId,
            metric: rec.metric,
            value: rec.value,
            periodStart,
            periodEnd,
          },
        });
      }
    }

    await this.prisma.teamUsage.updateMany({
      data: {
        apiRequestsMonth: 0,
        bandwidthMonth: BigInt(0),
        mauCount: 0,
        periodStart: periodEnd,
        lastCalculatedAt: now,
      },
    });

    this.logger.log(`Monthly counters reset for ${allUsage.length} team(s)`);
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async recalculateAllTeams(): Promise<void> {
    this.logger.log('Starting periodic usage recalculation...');
    const teams = await this.prisma.team.findMany({ select: { id: true } });

    for (const team of teams) {
      try {
        await this.recalculateTeamUsage(team.id);
      } catch (err: any) {
        this.logger.error(`Failed to recalculate usage for team ${team.id}: ${err.message}`);
      }
    }

    this.logger.log(`Usage recalculated for ${teams.length} team(s)`);
  }
}
