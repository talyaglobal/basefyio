import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DB_SIZE_FRESH_MS, UsageService, usageMonthKey } from './usage.service';
import {
  CustomerUsageRow,
  aggregateUsageRecords,
  parseUsagePeriod,
  priceOtherUsage,
  reconcileTeamUsage,
  sumCustomerRows,
  toCustomerProjectView,
} from './team-cost-report';
import {
  BillingPeriod,
  CostLine,
  CostTotals,
  INFRA_COST_CONFIG_KEY,
  InfraCostConfig,
  PeriodProgress,
  ProjectCostReport,
  ProjectUsageInput,
  describePeriod,
  mergeInfraCostConfig,
  priceProject,
  sumProjectCosts,
  tierHourlyRawUsd,
} from './project-cost.pricing';
import {
  RecurringRevenueSummary,
  RevenueState,
  classifyRevenue,
  monthlyRevenueUsd,
  summarizeRecurringRevenue,
  type RevenueSubscriptionInput,
} from './recurring-revenue';

/** Projects that still occupy infrastructure. Deleted/deactivated ones are frozen or gone. */
const BILLABLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/** DB sizes older than this are refreshed on read; the cron also runs 6-hourly. */
const DB_SIZE_STALE_MS = 6 * 60 * 60 * 1000;

const projectSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  createdAt: true,
  usage: {
    select: {
      dbSizeBytes: true,
      storageBytes: true,
      apiRequestsMonth: true,
      bandwidthMonth: true,
      storageCalculatedAt: true,
      dbSizeCalculatedAt: true,
      lastCalculatedAt: true,
    },
  },
  infrastructure: { select: { pgMemoryMb: true, pgCpuMillis: true, status: true } },
} satisfies Prisma.ProjectSelect;

/** Closed months offered in the period picker. */
const HISTORY_MONTHS = 12;

type ProjectRow = Prisma.ProjectGetPayload<{ select: typeof projectSelect }>;

/** Customer-facing line: priced figures only, never our raw cost. */
export interface CustomerCostLine {
  key: CostLine['key'];
  label: string;
  quantity: number;
  unit: CostLine['unit'];
  detail: string;
  amountUsd: number;
  projectedUsd: number;
}

export interface CustomerProjectCost {
  projectId: string;
  name: string;
  slug: string;
  status: string;
  computeTier: string;
  activeHours: number;
  lines: CustomerCostLine[];
  amountUsd: number;
  projectedUsd: number;
}

export interface CustomerRates {
  computeTiers: Array<{ name: string; vcpu: number; memoryGb: number; hourlyUsd: number; monthlyUsd: number }>;
  diskUsdPerGbMonth: number;
  egressUsdPerGb: number;
  apiRequestsUsdPerMillion: number;
}

export type { CustomerUsageRow } from './team-cost-report';

export interface TeamCostReport {
  currency: 'usd';
  generatedAt: string;
  /** The UTC calendar month — the same window the monthly usage counters cover. */
  period: PeriodProgress;
  /** `YYYY-MM` of the period shown. */
  periodKey: string;
  /** False for a closed month rebuilt from its month-end snapshot. */
  isCurrentPeriod: boolean;
  /** Months that can be shown, newest first; the current month is always first. */
  availablePeriods: string[];
  plan: { name: string; displayName: string; priceMonthlyUsd: number } | null;
  projects: CustomerProjectCost[];
  /**
   * Usage the team's counters hold that no project row shows — trashed or
   * deactivated projects, and traffic no current project carries. With these
   * rows the breakdown adds up to the Usage card.
   */
  otherUsage: CustomerUsageRow[];
  /** Sum of every row above, in cents. */
  totals: { amountUsd: number; projectedUsd: number };
  /** API requests and egress across all rows — equal to the team's usage counters. */
  usageTotals: { apiRequests: number; bandwidthBytes: number };
  rates: CustomerRates;
  /** True when at least one project has never had its file storage measured. */
  storagePending: boolean;
  /** When the database sizes shown were measured; null when none were. */
  dbSizeMeasuredAt: string | null;
  /** When file storage was last measured (a 6-hourly pass); null when never. */
  storageMeasuredAt: string | null;
}

export interface PlatformTeamCost {
  teamId: string;
  teamName: string;
  teamSlug: string;
  plan: {
    name: string;
    displayName: string;
    priceMonthlyUsd: number;
    status: string;
    /** Where the team stands for recurring revenue (see recurring-revenue.ts). */
    revenueState?: RevenueState;
    /** What the team adds to recurring revenue: 0 unless it is paying. */
    monthlyRevenueUsd?: number;
  } | null;
  projects: ProjectCostReport[];
  totals: CostTotals;
  /** The team's slice of the actual monthly bill, in proportion to its modeled cost. */
  billShareUsd?: number;
  /** Recurring revenue from the team minus its share of the actual bill. */
  marginUsd: number;
}

export interface PlatformCostReport {
  currency: 'usd';
  generatedAt: string;
  period: PeriodProgress;
  config: InfraCostConfig;
  summary: {
    teams: number;
    projects: number;
    /** What the host + block storage actually costs per month, from config. */
    actualMonthlyBillUsd: number;
    /**
     * Projected modeled cost of the projects for the whole period: every
     * project priced as if it reserved its tier. Shared hosting overcommits,
     * so this can be several times the actual bill.
     */
    allocatedRawUsd: number;
    /** The same allocation at customer prices. */
    allocatedPricedUsd: number;
    /** Recurring revenue across every team (one definition, see recurring-revenue.ts). */
    planRevenueUsd: number;
    /** Recurring revenue minus the modeled cost. */
    marginVsAllocatedUsd: number;
    /** Recurring revenue minus the actual bill. */
    marginVsBillUsd: number;
    /** allocatedRaw / actualBill — above 1 means the model over-recovers. */
    recoveryRatio: number;
    payingTeams?: number;
    paidPlanTeams?: number;
    revenueByState?: RecurringRevenueSummary['byState'];
    revenueDefinition?: string;
  };
  teams: PlatformTeamCost[];
  storagePending: boolean;
}

/** Recurring revenue for every team, plus each team's own state and amount. */
export interface PlatformRecurringRevenue extends RecurringRevenueSummary {
  byTeam: Map<string, { state: RevenueState; monthlyRevenueUsd: number }>;
}

@Injectable()
export class ProjectCostService {
  private readonly logger = new Logger(ProjectCostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
  ) {}

  // ── Config ───────────────────────────────────────────────

  async getConfig(): Promise<InfraCostConfig> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: INFRA_COST_CONFIG_KEY } });
    return mergeInfraCostConfig(row?.value);
  }

  async updateConfig(patch: unknown): Promise<InfraCostConfig> {
    const current = await this.getConfig();
    const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
    const server = p.server && typeof p.server === 'object' ? (p.server as Record<string, unknown>) : {};
    const next = mergeInfraCostConfig({ ...current, ...p, server: { ...current.server, ...server } });
    await this.prisma.systemSetting.upsert({
      where: { key: INFRA_COST_CONFIG_KEY },
      create: { key: INFRA_COST_CONFIG_KEY, value: next as unknown as Prisma.InputJsonValue },
      update: { value: next as unknown as Prisma.InputJsonValue },
    });
    return next;
  }

  // ── Period ───────────────────────────────────────────────

  /**
   * The Stripe period when one is current, otherwise the UTC calendar month —
   * which is also when the monthly usage counters reset.
   */
  resolvePeriod(
    sub: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null } | null | undefined,
    now = new Date(),
  ): BillingPeriod {
    if (
      sub?.currentPeriodStart &&
      sub.currentPeriodEnd &&
      sub.currentPeriodStart <= now &&
      now < sub.currentPeriodEnd
    ) {
      return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
    }
    return {
      start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
    };
  }

  // ── Reports ──────────────────────────────────────────────

  /**
   * The team's cost breakdown for the current UTC calendar month, or — with
   * `period: 'YYYY-MM'` — for a closed month rebuilt from its month-end
   * snapshot.
   *
   * Always the calendar month, never the Stripe billing period: the API and
   * egress counters behind the breakdown reset on the 1st (UTC), so a
   * subscription period starting mid-month mixed two counter windows and the
   * breakdown could not agree with the Usage card.
   */
  async getTeamReport(teamId: string, opts: { period?: string } = {}): Promise<TeamCostReport> {
    const now = new Date();
    const currentKey = usageMonthKey(now);
    const requested = opts.period?.trim();
    if (requested && requested !== currentKey) {
      const past = parseUsagePeriod(requested);
      if (!past || past.start >= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))) {
        throw new BadRequestException('period must be a past month as YYYY-MM');
      }
      return this.getPastTeamReport(teamId, requested, now);
    }

    const [cfg, sub, availablePeriods] = await Promise.all([
      this.getConfig(),
      this.prisma.subscription.findUnique({ where: { teamId }, include: { plan: true } }),
      this.listReportPeriods(teamId, currentKey),
    ]);
    await this.usage.ensureFreshDbSizes(teamId, DB_SIZE_FRESH_MS);

    const rows = await this.prisma.project.findMany({
      where: { teamId, status: { in: [...BILLABLE_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: projectSelect,
    });
    const period = this.resolvePeriod(null, now);
    const inputs = await this.toInputs(rows);
    const reports = inputs
      .map((i) => priceProject(cfg, period, i, now))
      .sort((a, b) => b.pricedUsd - a.pricedUsd);
    const projects = reports.map(toCustomerView);

    // Reconcile with the team counters the Usage card shows.
    const [teamUsage, inactive] = await Promise.all([
      this.usage.getTeamUsage(teamId),
      this.inactiveProjectUsage(teamId),
    ]);
    const shown = {
      apiRequests: inputs.reduce((s, i) => s + i.apiRequests, 0),
      bandwidthBytes: inputs.reduce((s, i) => s + i.bandwidthBytes, 0),
    };
    const otherUsage = this.otherUsageRows(cfg, period, {
      team: { apiRequests: teamUsage.apiRequestsMonth, bandwidthBytes: Number(teamUsage.bandwidthMonth) },
      projects: shown,
      inactive,
    });

    const lastDbSize = maxDate(rows.map((r) => r.usage?.dbSizeCalculatedAt));
    const lastStorage = maxDate(rows.map((r) => r.usage?.storageCalculatedAt));
    return {
      currency: 'usd',
      generatedAt: now.toISOString(),
      period: describePeriod(period, now),
      periodKey: currentKey,
      isCurrentPeriod: true,
      availablePeriods,
      plan: sub
        ? { name: sub.plan.name, displayName: sub.plan.displayName, priceMonthlyUsd: sub.plan.priceMonthly / 100 }
        : null,
      projects,
      otherUsage,
      totals: sumCustomerRows(projects, otherUsage),
      usageTotals: {
        apiRequests: shown.apiRequests + otherUsage.reduce((s, r) => s + r.apiRequests, 0),
        bandwidthBytes: shown.bandwidthBytes + otherUsage.reduce((s, r) => s + r.bandwidthBytes, 0),
      },
      rates: customerRates(cfg),
      storagePending: rows.some((r) => !r.usage?.storageCalculatedAt),
      dbSizeMeasuredAt: lastDbSize?.toISOString() ?? null,
      storageMeasuredAt: lastStorage?.toISOString() ?? null,
    };
  }

  /**
   * A closed month, rebuilt from the UsageRecord rows written when it closed
   * and priced at today's rates. Projects that are trashed or deactivated now
   * contribute their traffic only, to the "deleted and deactivated" row: their
   * stored sizes stopped being measured and would be stale.
   */
  private async getPastTeamReport(teamId: string, key: string, now: Date): Promise<TeamCostReport> {
    const period = parseUsagePeriod(key)!;
    const currentKey = usageMonthKey(now);
    // Rows written by a reset that ran on local time can sit a few hours off midnight UTC.
    const slack = 24 * 60 * 60 * 1000;
    const [cfg, sub, availablePeriods, records] = await Promise.all([
      this.getConfig(),
      this.prisma.subscription.findUnique({ where: { teamId }, include: { plan: true } }),
      this.listReportPeriods(teamId, currentKey),
      this.prisma.usageRecord.findMany({
        where: {
          teamId,
          periodStart: {
            gte: new Date(period.start.getTime() - slack),
            lt: new Date(period.start.getTime() + slack),
          },
        },
        select: { projectId: true, metric: true, value: true },
      }),
    ]);
    const snapshot = aggregateUsageRecords(records);
    const ids = [...snapshot.projects.keys()];
    const projectRows = ids.length
      ? await this.prisma.project.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            createdAt: true,
            infrastructure: { select: { pgMemoryMb: true, pgCpuMillis: true, status: true } },
          },
        })
      : [];

    const reports: ProjectCostReport[] = [];
    const inactive = { apiRequests: 0, bandwidthBytes: 0 };
    const shown = { apiRequests: 0, bandwidthBytes: 0 };
    for (const p of projectRows) {
      const m = snapshot.projects.get(p.id)!;
      if (!(BILLABLE_STATUSES as readonly string[]).includes(p.status)) {
        inactive.apiRequests += m.apiRequests;
        inactive.bandwidthBytes += m.bandwidthBytes;
        continue;
      }
      if (p.createdAt >= period.end) continue;
      const infra = p.infrastructure && p.infrastructure.status === 'ACTIVE' ? p.infrastructure : null;
      shown.apiRequests += m.apiRequests;
      shown.bandwidthBytes += m.bandwidthBytes;
      reports.push(
        priceProject(
          cfg,
          period,
          {
            id: p.id,
            name: p.name,
            slug: p.slug,
            // Its status during that month is not on record; it was metered, so it ran.
            status: 'ACTIVE',
            createdAt: p.createdAt,
            dbSizeBytes: m.dbSizeBytes,
            storageBytes: m.storageBytes,
            apiRequests: m.apiRequests,
            bandwidthBytes: m.bandwidthBytes,
            dedicatedMemoryMb: infra?.pgMemoryMb ?? null,
            dedicatedCpuMillis: infra?.pgCpuMillis ?? null,
          },
          period.end,
        ),
      );
    }
    reports.sort((a, b) => b.pricedUsd - a.pricedUsd);
    const projects = reports.map(toCustomerView);
    const otherUsage = this.otherUsageRows(cfg, period, {
      team: { apiRequests: snapshot.team.apiRequests, bandwidthBytes: snapshot.team.bandwidthBytes },
      projects: shown,
      inactive,
    });

    return {
      currency: 'usd',
      generatedAt: now.toISOString(),
      period: describePeriod(period, period.end),
      periodKey: key,
      isCurrentPeriod: false,
      availablePeriods,
      plan: sub
        ? { name: sub.plan.name, displayName: sub.plan.displayName, priceMonthlyUsd: sub.plan.priceMonthly / 100 }
        : null,
      projects,
      otherUsage,
      totals: sumCustomerRows(projects, otherUsage),
      usageTotals: {
        apiRequests: shown.apiRequests + otherUsage.reduce((s, r) => s + r.apiRequests, 0),
        bandwidthBytes: shown.bandwidthBytes + otherUsage.reduce((s, r) => s + r.bandwidthBytes, 0),
      },
      rates: customerRates(cfg),
      storagePending: false,
      dbSizeMeasuredAt: null,
      storageMeasuredAt: null,
    };
  }

  private otherUsageRows(
    cfg: InfraCostConfig,
    period: BillingPeriod,
    usage: Parameters<typeof reconcileTeamUsage>[0],
  ): CustomerUsageRow[] {
    const split = reconcileTeamUsage(usage);
    return [
      priceOtherUsage(cfg, period, 'inactive_projects', split.inactive),
      priceOtherUsage(cfg, period, 'unattributed', split.unattributed),
    ].filter((r): r is CustomerUsageRow => r !== null);
  }

  /** This month's traffic from the team's trashed and deactivated projects. */
  private async inactiveProjectUsage(teamId: string): Promise<{ apiRequests: number; bandwidthBytes: number }> {
    const rows = await this.prisma.project.findMany({
      where: { teamId, status: { notIn: [...BILLABLE_STATUSES] } },
      select: { id: true, usage: { select: { apiRequestsMonth: true, bandwidthMonth: true } } },
    });
    const live = await this.usage.getLiveProjectCounters(rows.map((r) => r.id));
    return rows.reduce(
      (acc, r) => {
        const l = live.get(r.id);
        acc.apiRequests += (r.usage?.apiRequestsMonth ?? 0) + (l?.apiRequests ?? 0);
        acc.bandwidthBytes += Number(r.usage?.bandwidthMonth ?? 0) + (l?.bandwidthBytes ?? 0);
        return acc;
      },
      { apiRequests: 0, bandwidthBytes: 0 },
    );
  }

  /** The current month first, then closed months that have a per-project snapshot. */
  private async listReportPeriods(teamId: string, currentKey: string): Promise<string[]> {
    try {
      const rows = await this.prisma.usageRecord.findMany({
        where: { teamId, projectId: { not: null } },
        distinct: ['periodStart'],
        select: { periodStart: true },
        orderBy: { periodStart: 'desc' },
        take: HISTORY_MONTHS + 1,
      });
      const keys = rows
        // A reset on local time may sit a few hours before midnight UTC; the
        // month it closed is the one its start falls nearest to.
        .map((r) => usageMonthKey(new Date(r.periodStart.getTime() + 12 * 60 * 60 * 1000)))
        .filter((k) => k < currentKey);
      return [currentKey, ...Array.from(new Set(keys)).slice(0, HISTORY_MONTHS)];
    } catch {
      return [currentKey];
    }
  }

  /**
   * Recurring revenue across every team — with or without projects — under
   * the one definition the whole root console uses.
   */
  async getRecurringRevenue(now = new Date()): Promise<PlatformRecurringRevenue> {
    const subs = await this.prisma.subscription.findMany({
      select: {
        teamId: true,
        status: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        billingDayOfMonth: true,
        currentPeriodEnd: true,
        studentDiscountPercent: true,
        plan: { select: { priceMonthly: true } },
        team: { select: { accountStatus: true } },
      },
    });
    const inputs = subs.map((s) => ({ teamId: s.teamId, input: toRevenueInput(s) }));
    const byTeam = new Map(
      inputs.map(({ teamId, input }) => [
        teamId,
        { state: classifyRevenue(input, now), monthlyRevenueUsd: monthlyRevenueUsd(input, now) },
      ]),
    );
    return { ...summarizeRecurringRevenue(inputs.map((i) => i.input), now), byTeam };
  }

  async getPlatformReport(): Promise<PlatformCostReport> {
    const now = new Date();
    const cfg = await this.getConfig();
    await this.ensureFreshDbSizes();
    const revenue = await this.getRecurringRevenue(now);

    const teams = await this.prisma.team.findMany({
      where: { projects: { some: { status: { in: [...BILLABLE_STATUSES] } } } },
      select: {
        id: true,
        name: true,
        slug: true,
        subscription: {
          select: {
            status: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            plan: { select: { name: true, displayName: true, priceMonthly: true } },
          },
        },
        projects: {
          where: { status: { in: [...BILLABLE_STATUSES] } },
          orderBy: { createdAt: 'asc' },
          select: projectSelect,
        },
      },
    });

    // One calendar-month window for everyone so teams are comparable.
    const period = this.resolvePeriod(null, now);
    const allRows = teams.flatMap((t) => t.projects);
    const inputs = await this.toInputs(allRows);
    const inputById = new Map(inputs.map((i) => [i.id, i]));

    const actualMonthlyBillUsd = round2(
      cfg.server.monthlyCostUsd + cfg.server.volumeGb * cfg.diskUsdPerGbMonth,
    );
    const priced = teams.map((t) => {
      const projects = t.projects
        .map((p) => priceProject(cfg, period, inputById.get(p.id)!, now))
        .sort((a, b) => b.rawUsd - a.rawUsd);
      return { team: t, projects, totals: sumProjectCosts(projects) };
    });
    const modeledTotal = priced.reduce((s, t) => s + t.totals.projectedRawUsd, 0);

    const teamReports: PlatformTeamCost[] = priced
      .map(({ team: t, projects, totals }) => {
        const teamRevenue = revenue.byTeam.get(t.id);
        const plan = t.subscription
          ? {
              name: t.subscription.plan.name,
              displayName: t.subscription.plan.displayName,
              priceMonthlyUsd: t.subscription.plan.priceMonthly / 100,
              status: t.subscription.status,
              revenueState: teamRevenue?.state,
              monthlyRevenueUsd: teamRevenue?.monthlyRevenueUsd ?? 0,
            }
          : null;
        // The modeled cost overcommits the shared host, so a team's real cost
        // is its proportional slice of the actual bill.
        const billShareUsd =
          modeledTotal > 0 ? round2((actualMonthlyBillUsd * totals.projectedRawUsd) / modeledTotal) : 0;
        return {
          teamId: t.id,
          teamName: t.name,
          teamSlug: t.slug,
          plan,
          projects,
          totals,
          billShareUsd,
          marginUsd: round2((teamRevenue?.monthlyRevenueUsd ?? 0) - billShareUsd),
        };
      })
      .sort((a, b) => b.totals.projectedRawUsd - a.totals.projectedRawUsd);

    const allocated = sumProjectCosts(teamReports.flatMap((t) => t.projects));
    const planRevenueUsd = revenue.mrrUsd;

    return {
      currency: 'usd',
      generatedAt: now.toISOString(),
      period: describePeriod(period, now),
      config: cfg,
      summary: {
        teams: teamReports.length,
        projects: allRows.length,
        actualMonthlyBillUsd,
        allocatedRawUsd: allocated.projectedRawUsd,
        allocatedPricedUsd: allocated.projectedPricedUsd,
        planRevenueUsd,
        marginVsAllocatedUsd: round2(planRevenueUsd - allocated.projectedRawUsd),
        marginVsBillUsd: round2(planRevenueUsd - actualMonthlyBillUsd),
        recoveryRatio: actualMonthlyBillUsd > 0 ? round2(allocated.projectedRawUsd / actualMonthlyBillUsd) : 0,
        payingTeams: revenue.payingTeams,
        paidPlanTeams: revenue.paidPlanTeams,
        revenueByState: revenue.byState,
        revenueDefinition: revenue.definition,
      },
      teams: teamReports,
      storagePending: allRows.some((r) => !r.usage?.storageCalculatedAt),
    };
  }

  /**
   * One project's report with our raw cost and the customer price side by
   * side, for the root console. Null when the project no longer occupies
   * infrastructure (deactivated or deleted).
   */
  async getProjectReport(projectId: string): Promise<ProjectCostReport | null> {
    const now = new Date();
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
    if (!project) return null;
    await this.ensureFreshDbSizes(project.teamId);

    const row = await this.prisma.project.findFirst({
      where: { id: projectId, status: { in: [...BILLABLE_STATUSES] } },
      select: projectSelect,
    });
    if (!row) return null;
    const [cfg, [input]] = await Promise.all([this.getConfig(), this.toInputs([row])]);
    return priceProject(cfg, this.resolvePeriod(null, now), input, now);
  }

  /** Re-measure every billable project's database now and flush live counters. */
  async refreshNow(): Promise<{ projects: number }> {
    const projects = await this.usage.refreshProjectDbSizes();
    await this.usage.flushProjectCounters();
    return { projects };
  }

  // ── Helpers ──────────────────────────────────────────────

  /** Platform-wide and single-project reports keep the 6-hour freshness. */
  private async ensureFreshDbSizes(teamId?: string): Promise<void> {
    await this.usage.ensureFreshDbSizes(teamId, DB_SIZE_STALE_MS);
  }

  private async toInputs(rows: ProjectRow[]): Promise<ProjectUsageInput[]> {
    const live = await this.usage.getLiveProjectCounters(rows.map((r) => r.id));
    return rows.map((r) => {
      const l = live.get(r.id);
      // Only a provisioned dedicated container reserves resources. A plan's
      // nominal allocation costs nothing until it is actually provisioned, so
      // shared projects are sized by their real footprint instead.
      const infra = r.infrastructure && r.infrastructure.status === 'ACTIVE' ? r.infrastructure : null;
      return {
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        createdAt: r.createdAt,
        dbSizeBytes: Number(r.usage?.dbSizeBytes ?? 0),
        storageBytes: Number(r.usage?.storageBytes ?? 0),
        apiRequests: (r.usage?.apiRequestsMonth ?? 0) + (l?.apiRequests ?? 0),
        bandwidthBytes: Number(r.usage?.bandwidthMonth ?? 0) + (l?.bandwidthBytes ?? 0),
        dedicatedMemoryMb: infra?.pgMemoryMb ?? null,
        dedicatedCpuMillis: infra?.pgCpuMillis ?? null,
      };
    });
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Map a subscription row onto the recurring-revenue inputs. */
export function toRevenueInput(s: {
  status: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingDayOfMonth: number | null;
  currentPeriodEnd: Date | null;
  studentDiscountPercent: number | null;
  plan: { priceMonthly: number };
  team?: { accountStatus: string } | null;
}): RevenueSubscriptionInput {
  return {
    status: s.status,
    priceMonthlyCents: s.plan.priceMonthly,
    studentDiscountPercent: s.studentDiscountPercent,
    stripeCustomerId: s.stripeCustomerId,
    stripeSubscriptionId: s.stripeSubscriptionId,
    billingDayOfMonth: s.billingDayOfMonth,
    currentPeriodEnd: s.currentPeriodEnd,
    accountStatus: s.team?.accountStatus ?? null,
  };
}

/** Customer figures in whole cents, each total the sum of the rows it sits over. */
function toCustomerView(r: ProjectCostReport): CustomerProjectCost {
  return toCustomerProjectView(r);
}

const maxDate = (dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((latest, d) => (d && (!latest || d > latest) ? d : latest), null);

function customerRates(cfg: InfraCostConfig): CustomerRates {
  const m = cfg.markup;
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  return {
    computeTiers: cfg.computeTiers.map((t) => {
      const hourly = tierHourlyRawUsd(t, cfg.server) * m;
      return { name: t.name, vcpu: t.vcpu, memoryGb: t.memoryGb, hourlyUsd: r4(hourly), monthlyUsd: round2(hourly * 730) };
    }),
    diskUsdPerGbMonth: r4(cfg.diskUsdPerGbMonth * m),
    egressUsdPerGb: r4(cfg.egressUsdPerGb * m),
    apiRequestsUsdPerMillion: r4(cfg.apiRequestsUsdPerMillion * m),
  };
}
