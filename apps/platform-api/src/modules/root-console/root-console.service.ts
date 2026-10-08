import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectCostService } from '../billing/project-cost.service';
import type { CostLine, ProjectCostReport } from '../billing/project-cost.pricing';
import { BucketInventory, PLATFORM_BUCKETS, StorageService } from '../storage/storage.service';

/** Cost figures for one project, ours and the customer's, for the current calendar month. */
export interface ConsoleProjectCost {
  computeTier: string;
  rawUsd: number;
  pricedUsd: number;
  projectedRawUsd: number;
  projectedPricedUsd: number;
}

export interface ConsoleProjectRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  databaseType: string;
  importSource: string;
  createdAt: string;
  team: { id: string; name: string; slug: string };
  owner: { id: string; email: string; name: string | null } | null;
  plan: { name: string; displayName: string; priceMonthlyUsd: number; status: string } | null;
  dbSizeBytes: number;
  storageBytes: number;
  storageMeasuredAt: string | null;
  bucketCount: number | null;
  apiRequests: number;
  bandwidthBytes: number;
  cost: ConsoleProjectCost | null;
}

export interface ConsoleBucket {
  bucket: string;
  /** The bucket name inside the project, without the `bf-<slug>-` prefix. */
  name: string;
  sizeBytes: number;
  objectCount: number;
  createdAt: string;
  public?: boolean;
}

export interface ConsoleTableSize {
  schema: string;
  name: string;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
  estimatedRows: number;
}

export interface ConsoleUsageMonth {
  periodStart: string;
  apiRequests: number;
  bandwidthBytes: number;
  storageBytes: number;
  dbSizeBytes: number;
}

export type StorageCategory = 'project' | 'deleted_project' | 'platform' | 'orphan';

export interface ConsolePlanTeam {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  status: string;
  projects: number;
  members: number;
  createdAt: string;
  subscribedAt: string;
  currentPeriodEnd: string | null;
  /** Our raw cost for the team's projects, projected to month end. */
  projectedRawUsd: number;
  footprintBytes: number;
}

export interface ConsolePlanMix {
  name: string;
  displayName: string;
  priceMonthlyUsd: number;
  teams: number;
  paying: number;
  teamList: ConsolePlanTeam[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class RootConsoleService {
  private readonly logger = new Logger(RootConsoleService.name);
  private storageRefreshRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly costs: ProjectCostService,
    private readonly storage: StorageService,
  ) {}

  // ── Overview ─────────────────────────────────────────────

  async getOverview() {
    const now = new Date();
    const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));

    const [
      report,
      inventory,
      users,
      usersLast30d,
      activeLast30d,
      teams,
      projectsByStatus,
      subscriptions,
      usageTotals,
      signupRows,
      projectRows,
    ] = await Promise.all([
      this.costs.getPlatformReport(),
      this.storage.getBucketInventory(),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: since30d } } }),
      this.prisma.user.count({ where: { lastLoginAt: { gte: since30d } } }),
      this.prisma.team.count(),
      this.prisma.project.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.subscription.findMany({
        select: {
          status: true,
          currentPeriodEnd: true,
          createdAt: true,
          plan: { select: { name: true, displayName: true, priceMonthly: true } },
          team: {
            select: {
              id: true,
              name: true,
              slug: true,
              createdAt: true,
              _count: { select: { projects: { where: { status: { not: 'DELETED' } } }, members: true } },
              members: {
                where: { role: 'OWNER' },
                take: 1,
                select: { user: { select: { email: true } } },
              },
            },
          },
        },
      }),
      this.prisma.projectUsage.aggregate({
        where: { project: { status: { in: ['ACTIVE', 'PAUSED'] } } },
        _sum: { dbSizeBytes: true, storageBytes: true, apiRequestsMonth: true, bandwidthMonth: true },
      }),
      this.prisma.user.findMany({ where: { createdAt: { gte: sixMonthsAgo } }, select: { createdAt: true } }),
      this.prisma.project.findMany({
        where: { createdAt: { gte: sixMonthsAgo } },
        select: { createdAt: true },
      }),
    ]);

    // What each team costs us and occupies, from the same report as the totals.
    const teamCost = new Map(
      report.teams.map((t) => [
        t.teamId,
        {
          projectedRawUsd: t.totals.projectedRawUsd,
          footprintBytes: t.projects.reduce((sum, p) => sum + p.dbSizeBytes + p.storageBytes, 0),
        },
      ]),
    );

    // Plan mix and recurring revenue across every team, not only those with projects.
    const planMix = new Map<string, ConsolePlanMix>();
    let mrrUsd = 0;
    let payingTeams = 0;
    for (const s of subscriptions) {
      const price = s.plan.priceMonthly / 100;
      const entry = planMix.get(s.plan.name) ?? {
        name: s.plan.name,
        displayName: s.plan.displayName,
        priceMonthlyUsd: price,
        teams: 0,
        paying: 0,
        teamList: [],
      };
      entry.teams += 1;
      const tc = teamCost.get(s.team.id);
      entry.teamList.push({
        id: s.team.id,
        name: s.team.name,
        slug: s.team.slug,
        ownerEmail: s.team.members[0]?.user.email ?? null,
        status: s.status,
        projects: s.team._count.projects,
        members: s.team._count.members,
        createdAt: s.team.createdAt.toISOString(),
        subscribedAt: s.createdAt.toISOString(),
        currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        projectedRawUsd: tc?.projectedRawUsd ?? 0,
        footprintBytes: tc?.footprintBytes ?? 0,
      });
      if (price > 0 && (s.status === 'ACTIVE' || s.status === 'TRIALING' || s.status === 'PAST_DUE')) {
        entry.paying += 1;
        payingTeams += 1;
        mrrUsd += price;
      }
      planMix.set(s.plan.name, entry);
    }

    const months: { month: string; signups: number; projects: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      months.push({ month: d.toISOString().slice(0, 7), signups: 0, projects: 0 });
    }
    const bump = (date: Date, key: 'signups' | 'projects') => {
      const m = months.find((x) => x.month === date.toISOString().slice(0, 7));
      if (m) m[key] += 1;
    };
    signupRows.forEach((u) => bump(u.createdAt, 'signups'));
    projectRows.forEach((p) => bump(p.createdAt, 'projects'));

    const statusCount = (s: string) => projectsByStatus.find((r) => r.status === s)?._count._all ?? 0;
    const allProjects = report.teams.flatMap((t) =>
      t.projects.map((p) => ({ ...p, teamName: t.teamName, teamId: t.teamId })),
    );
    const top = (key: (p: (typeof allProjects)[number]) => number) =>
      [...allProjects]
        .sort((a, b) => key(b) - key(a))
        .slice(0, 6)
        .map((p) => ({
          id: p.projectId,
          name: p.name,
          teamName: p.teamName,
          projectedRawUsd: p.projectedRawUsd,
          projectedPricedUsd: p.projectedPricedUsd,
          dbSizeBytes: p.dbSizeBytes,
          storageBytes: p.storageBytes,
        }));

    return {
      generatedAt: now.toISOString(),
      period: report.period,
      counts: {
        users,
        usersLast30d,
        activeUsersLast30d: activeLast30d,
        teams,
        payingTeams,
        projects: {
          active: statusCount('ACTIVE'),
          paused: statusCount('PAUSED'),
          deactivated: statusCount('DEACTIVATED'),
          deleted: statusCount('DELETED'),
        },
      },
      money: {
        mrrUsd: round2(mrrUsd),
        actualMonthlyBillUsd: report.summary.actualMonthlyBillUsd,
        allocatedRawUsd: report.summary.allocatedRawUsd,
        allocatedPricedUsd: report.summary.allocatedPricedUsd,
        marginVsBillUsd: round2(mrrUsd - report.summary.actualMonthlyBillUsd),
        recoveryRatio: report.summary.recoveryRatio,
        markup: report.config.markup,
      },
      footprint: {
        dbBytes: Number(usageTotals._sum.dbSizeBytes ?? 0),
        projectStorageBytes: Number(usageTotals._sum.storageBytes ?? 0),
        apiRequestsMonth: usageTotals._sum.apiRequestsMonth ?? 0,
        bandwidthMonthBytes: Number(usageTotals._sum.bandwidthMonth ?? 0),
        storage: this.summarizeInventory(inventory, await this.projectStatusIndex()),
      },
      plans: [...planMix.values()]
        .sort((a, b) => a.priceMonthlyUsd - b.priceMonthlyUsd)
        .map((p) => ({ ...p, teamList: p.teamList.sort((a, b) => b.projectedRawUsd - a.projectedRawUsd) })),
      months,
      topByCost: top((p) => p.projectedRawUsd),
      topByFootprint: top((p) => p.dbSizeBytes + p.storageBytes),
      storagePending: report.storagePending,
    };
  }

  // ── Projects ─────────────────────────────────────────────

  async listProjects(includeDeleted = false): Promise<{ generatedAt: string; storageMeasuredAt: string | null; projects: ConsoleProjectRow[] }> {
    const [report, inventory, rows] = await Promise.all([
      this.costs.getPlatformReport(),
      this.storage.getBucketInventory(),
      this.prisma.project.findMany({
        where: includeDeleted ? {} : { status: { not: 'DELETED' } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          databaseType: true,
          importSource: true,
          createdAt: true,
          team: {
            select: {
              id: true,
              name: true,
              slug: true,
              subscription: {
                select: { status: true, plan: { select: { name: true, displayName: true, priceMonthly: true } } },
              },
              members: {
                where: { role: 'OWNER' },
                take: 1,
                select: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
              },
            },
          },
          usage: {
            select: {
              dbSizeBytes: true,
              storageBytes: true,
              apiRequestsMonth: true,
              bandwidthMonth: true,
              storageCalculatedAt: true,
            },
          },
        },
      }),
    ]);

    const costById = new Map<string, ProjectCostReport>();
    for (const t of report.teams) for (const p of t.projects) costById.set(p.projectId, p);
    const bucketsByProject = new Map<string, number>();
    for (const b of inventory?.buckets ?? []) {
      if (b.projectId) bucketsByProject.set(b.projectId, (bucketsByProject.get(b.projectId) ?? 0) + 1);
    }

    const projects = rows.map((r): ConsoleProjectRow => {
      const cost = costById.get(r.id);
      const ownerUser = r.team.members[0]?.user;
      const sub = r.team.subscription;
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        databaseType: r.databaseType,
        importSource: r.importSource,
        createdAt: r.createdAt.toISOString(),
        team: { id: r.team.id, name: r.team.name, slug: r.team.slug },
        owner: ownerUser
          ? {
              id: ownerUser.id,
              email: ownerUser.email,
              name: [ownerUser.firstName, ownerUser.lastName].filter(Boolean).join(' ') || null,
            }
          : null,
        plan: sub
          ? {
              name: sub.plan.name,
              displayName: sub.plan.displayName,
              priceMonthlyUsd: sub.plan.priceMonthly / 100,
              status: sub.status,
            }
          : null,
        // The cost report carries live counters on top of the stored snapshot.
        dbSizeBytes: cost?.dbSizeBytes ?? Number(r.usage?.dbSizeBytes ?? 0),
        storageBytes: cost?.storageBytes ?? Number(r.usage?.storageBytes ?? 0),
        storageMeasuredAt: r.usage?.storageCalculatedAt?.toISOString() ?? null,
        bucketCount: inventory ? (bucketsByProject.get(r.id) ?? 0) : null,
        apiRequests: cost?.apiRequests ?? r.usage?.apiRequestsMonth ?? 0,
        bandwidthBytes: cost?.bandwidthBytes ?? Number(r.usage?.bandwidthMonth ?? 0),
        cost: cost
          ? {
              computeTier: cost.computeTier,
              rawUsd: cost.rawUsd,
              pricedUsd: cost.pricedUsd,
              projectedRawUsd: cost.projectedRawUsd,
              projectedPricedUsd: cost.projectedPricedUsd,
            }
          : null,
      };
    });

    return { generatedAt: new Date().toISOString(), storageMeasuredAt: inventory?.measuredAt ?? null, projects };
  }

  async getProject(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        databaseType: true,
        importSource: true,
        dbName: true,
        storagePrefix: true,
        createdAt: true,
        deletedAt: true,
        deactivatedAt: true,
        team: {
          select: {
            id: true,
            name: true,
            slug: true,
            createdAt: true,
            subscription: {
              select: {
                status: true,
                currentPeriodEnd: true,
                plan: { select: { name: true, displayName: true, priceMonthly: true } },
              },
            },
            members: {
              orderBy: { role: 'asc' },
              select: { role: true, user: { select: { id: true, email: true, firstName: true, lastName: true } } },
            },
            _count: { select: { projects: true } },
          },
        },
        infrastructure: {
          select: { pgContainerName: true, pgMemoryMb: true, pgCpuMillis: true, status: true, provisionedAt: true },
        },
        usage: { select: { storageCalculatedAt: true, dbSizeCalculatedAt: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const [cost, buckets, tables, history] = await Promise.all([
      this.costs.getProjectReport(projectId),
      this.projectBuckets(project.id, project.status, project.storagePrefix ?? project.slug),
      this.tableSizes(project.dbName),
      this.usageHistory(project.id),
    ]);

    const sub = project.team.subscription;
    return {
      generatedAt: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        status: project.status,
        databaseType: project.databaseType,
        importSource: project.importSource,
        dbName: project.dbName,
        createdAt: project.createdAt.toISOString(),
        deletedAt: project.deletedAt?.toISOString() ?? null,
        deactivatedAt: project.deactivatedAt?.toISOString() ?? null,
      },
      team: {
        id: project.team.id,
        name: project.team.name,
        slug: project.team.slug,
        createdAt: project.team.createdAt.toISOString(),
        projectCount: project.team._count.projects,
        plan: sub
          ? {
              name: sub.plan.name,
              displayName: sub.plan.displayName,
              priceMonthlyUsd: sub.plan.priceMonthly / 100,
              status: sub.status,
              currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
            }
          : null,
        members: project.team.members.map((m) => ({
          role: m.role,
          id: m.user.id,
          email: m.user.email,
          name: [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') || null,
        })),
      },
      infrastructure: project.infrastructure
        ? {
            ...project.infrastructure,
            provisionedAt: project.infrastructure.provisionedAt?.toISOString() ?? null,
          }
        : null,
      cost: cost ? toConsoleCost(cost) : null,
      storage: {
        measuredAt: buckets.measuredAt,
        live: buckets.live,
        totalBytes: buckets.items.reduce((s, b) => s + b.sizeBytes, 0),
        objectCount: buckets.items.reduce((s, b) => s + b.objectCount, 0),
        buckets: buckets.items,
      },
      database: {
        sizeBytes: cost?.dbSizeBytes ?? null,
        measuredAt: project.usage?.dbSizeCalculatedAt?.toISOString() ?? null,
        tables: tables.items,
        tablesError: tables.error,
      },
      history,
    };
  }

  // ── Storage ──────────────────────────────────────────────

  async getStorage() {
    const [inventory, index] = await Promise.all([this.storage.getBucketInventory(), this.projectStatusIndex()]);
    const buckets = (inventory?.buckets ?? [])
      .map((b) => {
        const p = b.projectId ? index.get(b.projectId) : undefined;
        return {
          ...b,
          category: categorize(b.bucket, p?.status),
          project: p ? { id: b.projectId!, name: p.name, slug: p.slug, status: p.status, teamName: p.teamName } : null,
        };
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    return {
      measuredAt: inventory?.measuredAt ?? null,
      refreshing: this.storageRefreshRunning,
      summary: this.summarizeInventory(inventory, index),
      buckets,
    };
  }

  /** Walks every bucket in the background; the inventory updates when it finishes. */
  refreshStorage(): { started: boolean } {
    if (this.storageRefreshRunning) return { started: false };
    this.storageRefreshRunning = true;
    this.storage
      .recalculateStorageUsage()
      .catch((err) => this.logger.warn(`Storage refresh failed: ${err.message}`))
      .finally(() => {
        this.storageRefreshRunning = false;
      });
    return { started: true };
  }

  // ── Helpers ──────────────────────────────────────────────

  private async projectStatusIndex() {
    const rows = await this.prisma.project.findMany({
      select: { id: true, name: true, slug: true, status: true, team: { select: { name: true } } },
    });
    return new Map(rows.map((r) => [r.id, { name: r.name, slug: r.slug, status: r.status as string, teamName: r.team.name }]));
  }

  private summarizeInventory(
    inventory: BucketInventory | null,
    index: Map<string, { status: string }>,
  ) {
    const totals: Record<StorageCategory, number> = { project: 0, deleted_project: 0, platform: 0, orphan: 0 };
    let objects = 0;
    for (const b of inventory?.buckets ?? []) {
      const status = b.projectId ? index.get(b.projectId)?.status : undefined;
      totals[categorize(b.bucket, status)] += b.sizeBytes;
      objects += b.objectCount;
    }
    return {
      measuredAt: inventory?.measuredAt ?? null,
      bucketCount: inventory?.buckets.length ?? 0,
      objectCount: objects,
      totalBytes: Object.values(totals).reduce((s, n) => s + n, 0),
      byCategory: totals,
    };
  }

  private async projectBuckets(
    projectId: string,
    status: string,
    storagePrefix: string,
  ): Promise<{ live: boolean; measuredAt: string | null; items: ConsoleBucket[] }> {
    const prefix = `bf-${storagePrefix}-`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    // An active project's buckets are listed live; otherwise use the last full pass.
    if (status === 'ACTIVE') {
      try {
        const live = await this.storage.listBuckets(projectId);
        return {
          live: true,
          measuredAt: new Date().toISOString(),
          items: live
            .map((b) => ({
              bucket: b.id,
              name: b.name,
              sizeBytes: b.totalSize,
              objectCount: b.objectCount,
              createdAt: b.createdAt,
              public: b.public,
            }))
            .sort((a, b) => b.sizeBytes - a.sizeBytes),
        };
      } catch (err: any) {
        this.logger.warn(`Live bucket listing failed for ${projectId}: ${err.message}`);
      }
    }
    const inventory = await this.storage.getBucketInventory();
    return {
      live: false,
      measuredAt: inventory?.measuredAt ?? null,
      items: (inventory?.buckets ?? [])
        .filter((b) => b.projectId === projectId)
        .map((b) => ({
          bucket: b.bucket,
          name: b.bucket.startsWith(prefix) ? b.bucket.slice(prefix.length) : b.bucket,
          sizeBytes: b.sizeBytes,
          objectCount: b.objectCount,
          createdAt: b.createdAt,
        }))
        .sort((a, b) => b.sizeBytes - a.sizeBytes),
    };
  }

  /** The largest relations in a project's database, measured live. */
  private async tableSizes(dbName: string): Promise<{ items: ConsoleTableSize[]; error: string | null }> {
    const pool = new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: dbName,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    try {
      const { rows } = await pool.query<{
        schema: string;
        name: string;
        total_bytes: string;
        table_bytes: string;
        index_bytes: string;
        est_rows: string;
      }>(
        `SELECT n.nspname AS schema, c.relname AS name,
                pg_total_relation_size(c.oid)::bigint AS total_bytes,
                pg_relation_size(c.oid)::bigint AS table_bytes,
                pg_indexes_size(c.oid)::bigint AS index_bytes,
                GREATEST(c.reltuples, 0)::bigint AS est_rows
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'm')
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT 30`,
      );
      return {
        items: rows.map((r) => ({
          schema: r.schema,
          name: r.name,
          totalBytes: Number(r.total_bytes),
          tableBytes: Number(r.table_bytes),
          indexBytes: Number(r.index_bytes),
          estimatedRows: Number(r.est_rows),
        })),
        error: null,
      };
    } catch (err: any) {
      return { items: [], error: err.message };
    } finally {
      await pool.end().catch(() => {});
    }
  }

  /** Closed months from the usage ledger, newest first. */
  private async usageHistory(projectId: string): Promise<ConsoleUsageMonth[]> {
    const records = await this.prisma.usageRecord.findMany({
      where: { projectId },
      orderBy: { periodStart: 'desc' },
      take: 12 * 4,
      select: { metric: true, value: true, periodStart: true },
    });
    const byMonth = new Map<string, ConsoleUsageMonth>();
    for (const r of records) {
      const key = r.periodStart.toISOString();
      const m = byMonth.get(key) ?? { periodStart: key, apiRequests: 0, bandwidthBytes: 0, storageBytes: 0, dbSizeBytes: 0 };
      const v = Number(r.value);
      if (r.metric === 'api_requests') m.apiRequests = v;
      else if (r.metric === 'bandwidth') m.bandwidthBytes = v;
      else if (r.metric === 'storage_bytes') m.storageBytes = v;
      else if (r.metric === 'db_size_bytes') m.dbSizeBytes = v;
      byMonth.set(key, m);
    }
    return [...byMonth.values()].slice(0, 12);
  }
}

function categorize(bucket: string, projectStatus: string | undefined): StorageCategory {
  if (PLATFORM_BUCKETS.includes(bucket)) return 'platform';
  if (!projectStatus) return 'orphan';
  return projectStatus === 'DELETED' || projectStatus === 'DEACTIVATED' ? 'deleted_project' : 'project';
}

function toConsoleCost(r: ProjectCostReport) {
  return {
    computeTier: r.computeTier,
    activeHours: r.activeHours,
    apiRequests: r.apiRequests,
    bandwidthBytes: r.bandwidthBytes,
    lines: r.lines.map((l: CostLine) => ({
      key: l.key,
      label: l.label,
      detail: l.detail,
      rawUsd: l.rawUsd,
      pricedUsd: l.pricedUsd,
      projectedRawUsd: l.projectedRawUsd,
      projectedPricedUsd: l.projectedPricedUsd,
    })),
    rawUsd: r.rawUsd,
    pricedUsd: r.pricedUsd,
    projectedRawUsd: r.projectedRawUsd,
    projectedPricedUsd: r.projectedPricedUsd,
  };
}
