import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** Counters outlive a month so a late reset never loses the tail of a period. */
const COUNTER_TTL_SECONDS = 35 * 24 * 60 * 60;

/** A month's active-user set is read once more at the reset, then may go. */
const MAU_TTL_SECONDS = 40 * 24 * 60 * 60;

/** Projects that still occupy infrastructure and therefore get metered. */
const BILLABLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/** Statuses that hold a plan project slot: everything but the trash and the freezer. */
const NON_SLOT_STATUSES = ['DELETED', 'DEACTIVATED'] as const;

/**
 * Database sizes are cheap to measure (one pg_database_size per database), so a
 * team looking at Billing gets figures at most this old instead of waiting for
 * the 6-hourly pass.
 */
export const DB_SIZE_FRESH_MS = 15 * 60 * 1000;

/** UTC calendar month, `YYYY-MM` — the window the monthly counters cover. */
export function usageMonthKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

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

  private mauKey(teamId: string, month: string): string {
    return `usage:mau:${teamId}:${month}`;
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

  /** Count egress: bytes sent back to the caller. Uploads are not bandwidth. */
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

  /**
   * Record that a signed-in end user of one of the team's projects was active
   * this month. A HyperLogLog per team and month keeps it to a few KB however
   * many users there are; the count is approximate to well under 1%.
   *
   * Only call this with a user whose token was verified — see the usage
   * tracking middleware.
   */
  async trackActiveUser(teamId: string, userId: string, projectId?: string | null): Promise<void> {
    const key = this.mauKey(teamId, usageMonthKey());
    const client = this.redis.getClient();
    // Realm user ids are per project; keying by project keeps two projects'
    // users apart even if an id were ever reused.
    await client.pfadd(key, projectId ? `${projectId}:${userId}` : userId);
    await client.expire(key, MAU_TTL_SECONDS);
  }

  /** Distinct active end users this month, or null when Redis cannot say. */
  async countMonthlyActiveUsers(teamId: string, month: string = usageMonthKey()): Promise<number | null> {
    try {
      return await this.redis.getClient().pfcount(this.mauKey(teamId, month));
    } catch (err: any) {
      this.logger.debug(`Monthly active users unavailable for team ${teamId}: ${err.message}`);
      return null;
    }
  }

  /** Projects that hold a plan slot: not trashed, not deactivated, not a preview branch. */
  async countActiveProjects(teamId: string): Promise<number> {
    return this.prisma.project.count({
      where: { teamId, status: { notIn: [...NON_SLOT_STATUSES] }, parentProjectId: null },
    });
  }

  async countMembers(teamId: string): Promise<number> {
    return this.prisma.teamMember.count({ where: { teamId } });
  }

  /**
   * The team's usage against its plan.
   *
   * Project and member counts are counted live rather than read from the
   * stored counter: that counter was kept with ±1 updates that could be missed
   * (a restore never added one back) or doubled (deleting a deactivated project
   * took one off twice), and a quota check reading it let a team past its plan's
   * project limit. A team without a usage row gets one instead of a null that
   * every quota check treated as "no limit".
   */
  async getTeamUsage(teamId: string) {
    const usage = await this.prisma.teamUsage.upsert({
      where: { teamId },
      update: {},
      create: { teamId },
    });

    const [apiReqs, bw] = await Promise.all([
      this.redis.get(this.apiRequestsKey(teamId)),
      this.redis.get(this.bandwidthKey(teamId)),
    ]);
    const [projectCount, memberCount, mau, measured] = await Promise.all([
      this.countActiveProjects(teamId),
      this.countMembers(teamId),
      this.countMonthlyActiveUsers(teamId),
      this.measurementTimes(teamId),
    ]);

    return {
      ...usage,
      projectCount,
      memberCount,
      apiRequestsMonth: usage.apiRequestsMonth + parseInt(apiReqs || '0', 10),
      bandwidthMonth: usage.bandwidthMonth + BigInt(bw || '0'),
      mauCount: mau ?? usage.mauCount,
      /** When the database sizes behind dbSizeBytes were last measured. */
      dbSizeMeasuredAt: measured.dbSizeMeasuredAt,
      /** When file storage behind storageBytes was last measured (6-hourly pass). */
      storageMeasuredAt: measured.storageMeasuredAt,
    };
  }

  private async measurementTimes(
    teamId: string,
  ): Promise<{ dbSizeMeasuredAt: Date | null; storageMeasuredAt: Date | null }> {
    try {
      const agg = await this.prisma.projectUsage.aggregate({
        where: { project: { teamId, status: { in: [...BILLABLE_STATUSES] } } },
        _max: { dbSizeCalculatedAt: true, storageCalculatedAt: true },
      });
      return {
        dbSizeMeasuredAt: agg._max.dbSizeCalculatedAt ?? null,
        storageMeasuredAt: agg._max.storageCalculatedAt ?? null,
      };
    } catch {
      return { dbSizeMeasuredAt: null, storageMeasuredAt: null };
    }
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
   * Re-measure database sizes when the newest measurement for the team (or the
   * platform) is older than `maxAgeMs`, or a billable project was never
   * measured. Never throws: a report renders from whatever snapshot exists.
   */
  async ensureFreshDbSizes(teamId?: string, maxAgeMs: number = DB_SIZE_FRESH_MS): Promise<void> {
    const staleBefore = new Date(Date.now() - maxAgeMs);
    try {
      const stale = await this.prisma.project.count({
        where: {
          status: { in: [...BILLABLE_STATUSES] },
          ...(teamId ? { teamId } : {}),
          // Not lastCalculatedAt: the storage pass and counter flushes bump it
          // too, which made never-measured databases look fresh.
          OR: [
            { usage: null },
            { usage: { dbSizeCalculatedAt: null } },
            { usage: { dbSizeCalculatedAt: { lt: staleBefore } } },
          ],
        },
      });
      if (stale > 0) await this.refreshProjectDbSizes(teamId ? { teamId } : undefined);
    } catch (err: any) {
      this.logger.warn(`Could not refresh project DB sizes: ${err.message}`);
    }
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
        update: { dbSizeBytes: bytes, teamId: p.teamId, lastCalculatedAt: now, dbSizeCalculatedAt: now },
        create: { projectId: p.id, teamId: p.teamId, dbSizeBytes: bytes, lastCalculatedAt: now, dbSizeCalculatedAt: now },
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

  /**
   * Move the per-project Redis counters into ProjectUsage.
   *
   * By default only billable projects are flushed (the 6-hourly pass); the
   * month-end close passes `allStatuses` so a deactivated or trashed project's
   * leftover counter cannot carry into the next month and resurface if the
   * project comes back.
   */
  async flushProjectCounters(filter?: { teamId?: string; allStatuses?: boolean }): Promise<void> {
    const projects = await this.prisma.project.findMany({
      where: {
        ...(filter?.allStatuses ? {} : { status: { in: [...BILLABLE_STATUSES] } }),
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
          // Only set where a request was actually counted — this is what the
          // idle sweep reads to decide a project is no longer in use.
          ...(apiCount > 0 ? { lastRequestAt: new Date() } : {}),
        },
        create: {
          projectId: p.id,
          teamId: p.teamId,
          apiRequestsMonth: apiCount,
          bandwidthMonth: bwBytes,
          ...(apiCount > 0 ? { lastRequestAt: new Date() } : {}),
        },
      });
    }
  }

  /** Move the team-level Redis counters into TeamUsage. */
  private async flushTeamCounters(teamId: string): Promise<void> {
    const [api, bw] = await Promise.all([
      this.redis.getdel(this.apiRequestsKey(teamId)),
      this.redis.getdel(this.bandwidthKey(teamId)),
    ]);
    const apiCount = parseInt(api || '0', 10);
    const bwBytes = BigInt(bw || '0');
    await this.prisma.teamUsage.upsert({
      where: { teamId },
      update: { apiRequestsMonth: { increment: apiCount }, bandwidthMonth: { increment: bwBytes } },
      create: { teamId, apiRequestsMonth: apiCount, bandwidthMonth: bwBytes },
    });
  }

  /**
   * A project moved to another team takes its month-to-date API requests and
   * egress with it, so both teams' totals keep matching the projects they list.
   * Without this the old team kept the project's usage while the new team's
   * breakdown showed it — a gap between the team counter and the sum of its
   * project rows that never closed until the month ended.
   *
   * Usage is never created or destroyed here, only re-attributed; the old team
   * is floored at zero so a counter that was already short cannot go negative.
   */
  async moveProjectUsage(projectId: string, fromTeamId: string, toTeamId: string): Promise<void> {
    if (fromTeamId === toTeamId) return;
    const [api, bw] = await Promise.all([
      this.redis.getdel(this.projectApiRequestsKey(projectId)),
      this.redis.getdel(this.projectBandwidthKey(projectId)),
    ]);
    const pu = await this.prisma.projectUsage.upsert({
      where: { projectId },
      update: {
        teamId: toTeamId,
        apiRequestsMonth: { increment: parseInt(api || '0', 10) },
        bandwidthMonth: { increment: BigInt(bw || '0') },
      },
      create: {
        projectId,
        teamId: toTeamId,
        apiRequestsMonth: parseInt(api || '0', 10),
        bandwidthMonth: BigInt(bw || '0'),
      },
    });
    const apiMonth = pu.apiRequestsMonth;
    const bwMonth = pu.bandwidthMonth;
    if (apiMonth === 0 && bwMonth === BigInt(0)) return;

    // The old team's live counter must be in the row before it can be reduced.
    await this.flushTeamCounters(fromTeamId);
    const from = await this.prisma.teamUsage.findUnique({ where: { teamId: fromTeamId } });
    if (from) {
      await this.prisma.teamUsage.update({
        where: { teamId: fromTeamId },
        data: {
          apiRequestsMonth: Math.max(0, from.apiRequestsMonth - apiMonth),
          bandwidthMonth: from.bandwidthMonth > bwMonth ? from.bandwidthMonth - bwMonth : BigInt(0),
        },
      });
    }
    await this.prisma.teamUsage.upsert({
      where: { teamId: toTeamId },
      update: { apiRequestsMonth: { increment: apiMonth }, bandwidthMonth: { increment: bwMonth } },
      create: { teamId: toTeamId, apiRequestsMonth: apiMonth, bandwidthMonth: bwMonth },
    });
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
      select: { id: true },
    });

    if (!team) return;

    // Deactivated projects are frozen and must not consume the plan quota,
    // so only ACTIVE/PAUSED projects count toward projectCount. Preview
    // branches are free and capped per parent, so they do not count either.
    const [projectCount, memberCount] = await Promise.all([
      this.countActiveProjects(teamId),
      this.countMembers(teamId),
    ]);

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

  /**
   * Write the live project and member counts to the stored counter. Best
   * effort; the stored figure is only a cache now — quota checks count live.
   */
  async syncTeamCounts(teamId: string): Promise<void> {
    const [projectCount, memberCount] = await Promise.all([
      this.countActiveProjects(teamId),
      this.countMembers(teamId),
    ]);
    await this.prisma.teamUsage.upsert({
      where: { teamId },
      update: { projectCount, memberCount },
      create: { teamId, projectCount, memberCount },
    });
  }

  // The four methods below keep their names for existing callers, which call
  // them right after the change they describe. They recount rather than add or
  // subtract one, so a missed or repeated call can no longer drift the figure.

  async incrementProjectCount(teamId: string): Promise<void> {
    await this.syncTeamCounts(teamId);
  }

  async decrementProjectCount(teamId: string): Promise<void> {
    await this.syncTeamCounts(teamId);
  }

  async incrementMemberCount(teamId: string): Promise<void> {
    await this.syncTeamCounts(teamId);
  }

  async decrementMemberCount(teamId: string): Promise<void> {
    await this.syncTeamCounts(teamId);
  }

  /**
   * Close the month: snapshot every team's and project's counters into
   * UsageRecord and reset them. Runs at 00:00 UTC on the 1st, the same UTC
   * calendar month the Billing breakdown reports on.
   */
  @Cron('0 0 1 * *', { timeZone: 'UTC' })
  async resetMonthlyCounters(): Promise<void> {
    this.logger.log('Resetting monthly usage counters...');

    const now = new Date();
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const closingMonth = usageMonthKey(periodStart);

    const allUsage = await this.prisma.teamUsage.findMany();

    for (const usage of allUsage) {
      const apiReqs = await this.redis.getdel(this.apiRequestsKey(usage.teamId));
      const bw = await this.redis.getdel(this.bandwidthKey(usage.teamId));
      const totalApi = usage.apiRequestsMonth + parseInt(apiReqs || '0', 10);
      const totalBw = usage.bandwidthMonth + BigInt(bw || '0');
      const mau = await this.countMonthlyActiveUsers(usage.teamId, closingMonth);

      const records = [
        { metric: 'api_requests', value: BigInt(totalApi) },
        { metric: 'bandwidth', value: totalBw },
        { metric: 'storage_bytes', value: usage.storageBytes },
        { metric: 'db_size_bytes', value: usage.dbSizeBytes },
        { metric: 'mau', value: BigInt(mau ?? usage.mauCount) },
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

    // Every project's live counter goes into its row first — including
    // deactivated and trashed projects, whose keys the 6-hourly flush skips —
    // so nothing from this month leaks into the next.
    try {
      await this.flushProjectCounters({ allStatuses: true });
    } catch (err: any) {
      this.logger.warn(`Month-end project counter flush failed: ${err.message}`);
    }

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
