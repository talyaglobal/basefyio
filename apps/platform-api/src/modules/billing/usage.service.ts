import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** Counters outlive a month so a late reset never loses the tail of a period. */
const COUNTER_TTL_SECONDS = 35 * 24 * 60 * 60;

/** Projects that still occupy infrastructure and therefore get metered. */
const BILLABLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  private apiRequestsKey(teamId: string): string {
    return `usage:api_requests:${teamId}`;
  }

  private bandwidthKey(teamId: string): string {
    return `usage:bandwidth:${teamId}`;
  }

  private projectApiRequestsKey(projectId: string): string {
    return `usage:api_requests:project:${projectId}`;
  }

  private projectBandwidthKey(projectId: string): string {
    return `usage:bandwidth:project:${projectId}`;
  }

  /**
   * Count one API request against the team and, when the request could be
   * attributed to a project, against that project too — the per-project
   * counter feeds the cost breakdown under Billing.
   */
  async trackApiRequest(teamId: string, projectId?: string | null): Promise<void> {
    const key = this.apiRequestsKey(teamId);
    await this.redis.incr(key);
    await this.redis.expire(key, COUNTER_TTL_SECONDS);
    if (projectId) {
      const pkey = this.projectApiRequestsKey(projectId);
      await this.redis.incr(pkey);
      await this.redis.expire(pkey, COUNTER_TTL_SECONDS);
    }
  }

  async trackBandwidth(teamId: string, bytes: number, projectId?: string | null): Promise<void> {
    const key = this.bandwidthKey(teamId);
    await this.redis.incrby(key, bytes);
    await this.redis.expire(key, COUNTER_TTL_SECONDS);
    if (projectId) {
      const pkey = this.projectBandwidthKey(projectId);
      await this.redis.incrby(pkey, bytes);
      await this.redis.expire(pkey, COUNTER_TTL_SECONDS);
    }
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

  /** Per-project counters that have not been flushed to the database yet. */
  async getLiveProjectCounters(
    projectIds: string[],
  ): Promise<Map<string, { apiRequests: number; bandwidthBytes: number }>> {
    const out = new Map<string, { apiRequests: number; bandwidthBytes: number }>();
    if (projectIds.length === 0) return out;
    try {
      const keys = projectIds.flatMap((id) => [this.projectApiRequestsKey(id), this.projectBandwidthKey(id)]);
      const values = await this.redis.mget(...keys);
      projectIds.forEach((id, i) => {
        out.set(id, {
          apiRequests: parseInt(values[i * 2] || '0', 10),
          bandwidthBytes: Number(values[i * 2 + 1] || '0'),
        });
      });
    } catch (err: any) {
      // Live counters are a nicety on top of the stored snapshot.
      this.logger.debug(`Live project counters unavailable: ${err.message}`);
    }
    return out;
  }

  /**
   * Measure `pg_database_size` for every billable project (optionally one
   * team's or an explicit list), store it on ProjectUsage and roll the sums up
   * into TeamUsage.dbSizeBytes — which nothing else populates.
   *
   * @returns the number of projects measured
   */
  async refreshProjectDbSizes(filter?: { teamId?: string; projectIds?: string[] }): Promise<number> {
    const projects = await this.prisma.project.findMany({
      where: {
        status: { in: [...BILLABLE_STATUSES] },
        ...(filter?.teamId ? { teamId: filter.teamId } : {}),
        ...(filter?.projectIds ? { id: { in: filter.projectIds } } : {}),
      },
      select: { id: true, teamId: true, dbName: true },
    });
    if (projects.length === 0) return 0;

    const sizes = await this.queryDatabaseSizes(Array.from(new Set(projects.map((p) => p.dbName))));
    if (sizes.size === 0) return 0; // the query failed — keep the previous snapshot

    const now = new Date();
    const byTeam = new Map<string, bigint>();
    for (const p of projects) {
      const bytes = sizes.get(p.dbName) ?? BigInt(0);
      byTeam.set(p.teamId, (byTeam.get(p.teamId) ?? BigInt(0)) + bytes);
      await this.prisma.projectUsage.upsert({
        where: { projectId: p.id },
        update: { dbSizeBytes: bytes, teamId: p.teamId, lastCalculatedAt: now },
        create: { projectId: p.id, teamId: p.teamId, dbSizeBytes: bytes, lastCalculatedAt: now },
      });
    }
    for (const [teamId, bytes] of byTeam) {
      await this.prisma.teamUsage.upsert({
        where: { teamId },
        update: { dbSizeBytes: bytes },
        create: { teamId, dbSizeBytes: bytes },
      });
    }
    return projects.length;
  }

  /** Move the per-project Redis counters into ProjectUsage. */
  async flushProjectCounters(filter?: { teamId?: string }): Promise<void> {
    const projects = await this.prisma.project.findMany({
      where: {
        status: { in: [...BILLABLE_STATUSES] },
        ...(filter?.teamId ? { teamId: filter.teamId } : {}),
      },
      select: { id: true, teamId: true },
    });
    for (const p of projects) {
      const [api, bw] = await Promise.all([
        this.redis.getdel(this.projectApiRequestsKey(p.id)),
        this.redis.getdel(this.projectBandwidthKey(p.id)),
      ]);
      const apiCount = parseInt(api || '0', 10);
      const bwBytes = BigInt(bw || '0');
      if (apiCount === 0 && bwBytes === BigInt(0)) continue;
      await this.prisma.projectUsage.upsert({
        where: { projectId: p.id },
        update: {
          apiRequestsMonth: { increment: apiCount },
          bandwidthMonth: { increment: bwBytes },
          lastCalculatedAt: new Date(),
        },
        create: {
          projectId: p.id,
          teamId: p.teamId,
          apiRequestsMonth: apiCount,
          bandwidthMonth: bwBytes,
        },
      });
    }
  }

  private async queryDatabaseSizes(dbNames: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (dbNames.length === 0) return out;
    const pool = new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: 'postgres',
      max: 1,
    });
    try {
      const result = await pool.query<{ datname: string; size_bytes: string }>(
        `SELECT datname, pg_database_size(datname)::bigint AS size_bytes
           FROM pg_database
          WHERE datname = ANY($1::text[])`,
        [dbNames],
      );
      for (const row of result.rows) out.set(row.datname, BigInt(row.size_bytes));
    } catch (err: any) {
      this.logger.warn(`Failed to measure project database sizes: ${err.message}`);
    } finally {
      await pool.end().catch(() => {});
    }
    return out;
  }

  async recalculateTeamUsage(teamId: string): Promise<void> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: {
        projects: {
          // Deactivated projects are frozen and must not consume the plan quota,
          // so only ACTIVE/PAUSED projects count toward projectCount.
          where: { status: { notIn: ['DELETED', 'DEACTIVATED'] } },
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

    // Per-project bookkeeping for the Billing cost breakdown. Best effort:
    // a failure here must not undo the team-level accounting above.
    try {
      await this.refreshProjectDbSizes({ teamId });
      await this.flushProjectCounters({ teamId });
    } catch (err: any) {
      this.logger.warn(`Project usage refresh failed for team ${teamId}: ${err.message}`);
    }
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

    // Close the month per project as well, so the cost history can be
    // reconstructed project by project.
    const projectUsages = await this.prisma.projectUsage.findMany();
    for (const pu of projectUsages) {
      const api = await this.redis.getdel(this.projectApiRequestsKey(pu.projectId));
      const bw = await this.redis.getdel(this.projectBandwidthKey(pu.projectId));
      const totalApi = pu.apiRequestsMonth + parseInt(api || '0', 10);
      const totalBw = pu.bandwidthMonth + BigInt(bw || '0');
      await this.prisma.usageRecord.createMany({
        data: [
          { metric: 'api_requests', value: BigInt(totalApi) },
          { metric: 'bandwidth', value: totalBw },
          { metric: 'storage_bytes', value: pu.storageBytes },
          { metric: 'db_size_bytes', value: pu.dbSizeBytes },
        ].map((rec) => ({
          teamId: pu.teamId,
          projectId: pu.projectId,
          metric: rec.metric,
          value: rec.value,
          periodStart,
          periodEnd,
        })),
      });
    }
    await this.prisma.projectUsage.updateMany({
      data: {
        apiRequestsMonth: 0,
        bandwidthMonth: BigInt(0),
        periodStart: periodEnd,
        lastCalculatedAt: now,
      },
    });

    this.logger.log(
      `Monthly counters reset for ${allUsage.length} team(s) and ${projectUsages.length} project(s)`,
    );
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
