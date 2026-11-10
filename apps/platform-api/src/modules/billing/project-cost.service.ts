import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageService } from './usage.service';
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
  scaleProjectRaw,
  billShareScale,
  tierHourlyRawUsd,
} from './project-cost.pricing';

/** Projects that still occupy infrastructure. Deleted/deactivated ones are frozen or gone. */
const BILLABLE_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/** The one definition of "paying": a priced plan whose subscription is live. Overview and Costs both use it. */
export const PAYING_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;
export const isPayingSubscription = (status: string, priceMonthlyCents: number) =>
  priceMonthlyCents > 0 && (PAYING_STATUSES as readonly string[]).includes(status);

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
      lastCalculatedAt: true,
    },
  },
  infrastructure: { select: { pgMemoryMb: true, pgCpuMillis: true, status: true } },
} satisfies Prisma.ProjectSelect;

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

export interface TeamCostReport {
  currency: 'usd';
  generatedAt: string;
  period: PeriodProgress;
  plan: { name: string; displayName: string; priceMonthlyUsd: number } | null;
  projects: CustomerProjectCost[];
  totals: { amountUsd: number; projectedUsd: number };
  /** What the listed projects metered this period, to set against the team-wide Usage figures. */
  metered: { apiRequests: number; bandwidthBytes: number };
  rates: CustomerRates;
  /** True when at least one project has never had its file storage measured. */
  storagePending: boolean;
}

export interface PlatformTeamCost {
  teamId: string;
  teamName: string;
  teamSlug: string;
  plan: { name: string; displayName: string; priceMonthlyUsd: number; status: string } | null;
  projects: ProjectCostReport[];
  totals: CostTotals;
  /** Plan revenue for the period minus the projected raw infrastructure cost. */
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
    /** Projected raw cost allocated to projects for the whole period, as their share of the real bill when the tier sum passes it. */
    allocatedRawUsd: number;
    /** The same projection with every project at its full tier, before fitting to the bill. */
    tierEstimateRawUsd: number;
    /** 1 when the tier sum fits the bill, otherwise the fraction of each tier estimate shown as a share. */
    billShare: number;
    /** The same allocation at customer prices. */
    allocatedPricedUsd: number;
    /** Plan list price of every paying subscription on the platform (same figure as the console Overview). */
    planRevenueUsd: number;
    payingTeams: number;
    marginVsAllocatedUsd: number;
    marginVsBillUsd: number;
    /** tierEstimate / actualBill — above 1 means every project costed at its full tier passes the bill. */
    recoveryRatio: number;
  };
  teams: PlatformTeamCost[];
  storagePending: boolean;
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

  async getTeamReport(teamId: string): Promise<TeamCostReport> {
    const now = new Date();
    const [cfg, sub] = await Promise.all([
      this.getConfig(),
      this.prisma.subscription.findUnique({ where: { teamId }, include: { plan: true } }),
    ]);
    await this.ensureFreshDbSizes(teamId);

    const rows = await this.prisma.project.findMany({
      where: { teamId, status: { in: [...BILLABLE_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: projectSelect,
    });
    const period = this.resolvePeriod(sub, now);
    const inputs = await this.toInputs(rows);
    const reports = inputs
      .map((i) => priceProject(cfg, period, i, now))
      .sort((a, b) => b.pricedUsd - a.pricedUsd);
    const projectViews = reports.map(toCustomerView);

    return {
      currency: 'usd',
      generatedAt: now.toISOString(),
      period: describePeriod(period, now),
      plan: sub
        ? { name: sub.plan.name, displayName: sub.plan.displayName, priceMonthlyUsd: sub.plan.priceMonthly / 100 }
        : null,
      projects: projectViews,
      // Sum of the cents shown on the rows, so the footer always adds up.
      totals: {
        amountUsd: round2(projectViews.reduce((s, p) => s + p.amountUsd, 0)),
        projectedUsd: round2(projectViews.reduce((s, p) => s + p.projectedUsd, 0)),
      },
      metered: {
        apiRequests: inputs.reduce((s, i) => s + i.apiRequests, 0),
        bandwidthBytes: inputs.reduce((s, i) => s + i.bandwidthBytes, 0),
      },
      rates: customerRates(cfg),
      storagePending: rows.some((r) => !r.usage?.storageCalculatedAt),
    };
  }

  async getPlatformReport(): Promise<PlatformCostReport> {
    const now = new Date();
    const cfg = await this.getConfig();
    await this.ensureFreshDbSizes();

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

    const teamReports: PlatformTeamCost[] = teams
      .map((t) => {
        const projects = t.projects
          .map((p) => priceProject(cfg, period, inputById.get(p.id)!, now))
          .sort((a, b) => b.rawUsd - a.rawUsd);
        const totals = sumProjectCosts(projects);
        const plan = t.subscription
          ? {
              name: t.subscription.plan.name,
              displayName: t.subscription.plan.displayName,
              priceMonthlyUsd: t.subscription.plan.priceMonthly / 100,
              status: t.subscription.status,
            }
          : null;
        return {
          teamId: t.id,
          teamName: t.name,
          teamSlug: t.slug,
          plan,
          projects,
          totals,
          marginUsd: round2((plan?.priceMonthlyUsd ?? 0) - totals.projectedRawUsd),
        };
      })
      .sort((a, b) => b.totals.projectedRawUsd - a.totals.projectedRawUsd);

    const tierEstimateRawUsd = sumProjectCosts(teamReports.flatMap((t) => t.projects)).projectedRawUsd;
    const paying = await this.prisma.subscription.findMany({
      where: { status: { in: [...PAYING_STATUSES] }, plan: { priceMonthly: { gt: 0 } } },
      select: { plan: { select: { priceMonthly: true } } },
    });
    const planRevenueUsd = round2(paying.reduce((sum, p) => sum + p.plan.priceMonthly / 100, 0));
    const actualMonthlyBillUsd = round2(
      cfg.server.monthlyCostUsd + cfg.server.volumeGb * cfg.diskUsdPerGbMonth,
    );
    // Every project is costed at its full tier, so the sum can pass the real bill: show shares of the bill.
    const billShare = billShareScale(tierEstimateRawUsd, actualMonthlyBillUsd);
    if (billShare < 1) {
      for (const t of teamReports) {
        t.projects = t.projects.map((p) => scaleProjectRaw(p, billShare));
        t.totals = sumProjectCosts(t.projects);
        t.marginUsd = round2((t.plan?.priceMonthlyUsd ?? 0) - t.totals.projectedRawUsd);
      }
    }

    const allocated = sumProjectCosts(teamReports.flatMap((t) => t.projects));
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
        tierEstimateRawUsd,
        billShare: round2(billShare),
        allocatedPricedUsd: allocated.projectedPricedUsd,
        planRevenueUsd,
        payingTeams: paying.length,
        marginVsAllocatedUsd: round2(planRevenueUsd - allocated.projectedRawUsd),
        marginVsBillUsd: round2(planRevenueUsd - actualMonthlyBillUsd),
        recoveryRatio: actualMonthlyBillUsd > 0 ? round2(tierEstimateRawUsd / actualMonthlyBillUsd) : 0,
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

  private async ensureFreshDbSizes(teamId?: string): Promise<void> {
    const staleBefore = new Date(Date.now() - DB_SIZE_STALE_MS);
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
      if (stale > 0) await this.usage.refreshProjectDbSizes(teamId ? { teamId } : undefined);
    } catch (err: any) {
      // The report must still render from whatever snapshot exists.
      this.logger.warn(`Could not refresh project DB sizes: ${err.message}`);
    }
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

/** A project's amount is whole cents, so the team total can be the sum of the rows. */
function toCustomerView(r: ProjectCostReport): CustomerProjectCost {
  const lines = r.lines.map((l) => ({
    key: l.key,
    label: l.label,
    quantity: l.quantity,
    unit: l.unit,
    detail: l.detail,
    amountUsd: l.pricedUsd,
    projectedUsd: l.projectedPricedUsd,
  }));
  return {
    projectId: r.projectId,
    name: r.name,
    slug: r.slug,
    status: r.status,
    computeTier: r.computeTier,
    activeHours: r.activeHours,
    lines,
    amountUsd: round2(r.pricedUsd),
    projectedUsd: round2(r.projectedPricedUsd),
  };
}

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
