import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageService } from './usage.service';
import {
  DEFAULT_ENFORCEMENT_MODES,
  EnforcedMetric,
  EnforcementModes,
  MetricState,
  PLAN_ENFORCEMENT_KEY,
  TeamEnforcementState,
  evaluatePlanUsage,
  formatFigure,
  parseEnforcementModes,
} from './plan-enforcement.rules';

const MODES_TTL_MS = 30_000;
const STATE_TTL_MS = 30_000;
const PROJECT_TEAM_TTL_MS = 5 * 60_000;
const CACHE_MAX = 5000;
/** One structured log line per team and metric per this interval. */
const LOG_EVERY_MS = 10 * 60_000;

export interface PlanRefusal {
  status: 402 | 429;
  metric: EnforcedMetric;
  teamId: string;
  /** Seconds until the counter resets (429 only). */
  retryAfterSeconds?: number;
  body: {
    statusCode: number;
    error: string;
    code: 'plan_limit_exceeded';
    resource: EnforcedMetric;
    message: string;
    current: string;
    limit: string | null;
    upgradeUrl: string;
  };
}

/**
 * Plan limit enforcement at run time: modes from system_settings (cached 30 s),
 * a team's evaluated state (cached 30 s per process), and the decisions the
 * usage middleware and the plan-gate interceptor ask for.
 *
 * Fails open: any error while deciding admits the request. A limit is a
 * commercial rule; an outage of the platform is worse than a few requests over.
 */
@Injectable()
export class PlanEnforcementService {
  private readonly logger = new Logger(PlanEnforcementService.name);
  private modesCache: { at: number; modes: EnforcementModes } | null = null;
  private readonly stateCache = new Map<string, { at: number; state: TeamEnforcementState }>();
  private readonly projectTeam = new Map<string, { at: number; teamId: string | null }>();
  private readonly lastLog = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  // ── Modes ────────────────────────────────────────────────────────────────

  async modes(): Promise<EnforcementModes> {
    const now = Date.now();
    if (this.modesCache && now - this.modesCache.at < MODES_TTL_MS) return this.modesCache.modes;
    let modes = { ...DEFAULT_ENFORCEMENT_MODES };
    try {
      const row = await this.prisma.systemSetting.findUnique({ where: { key: PLAN_ENFORCEMENT_KEY } });
      modes = parseEnforcementModes(row?.value);
    } catch (err: any) {
      // Keep the last known modes rather than falling back to the default.
      if (this.modesCache) return this.modesCache.modes;
      this.logger.warn(`Could not read ${PLAN_ENFORCEMENT_KEY}, using warn for every metric: ${err?.message ?? err}`);
    }
    this.modesCache = { at: now, modes };
    return modes;
  }

  /** Root: change one or more metrics' modes. Takes effect on every replica within 30 s. */
  async setModes(patch: Partial<EnforcementModes>): Promise<EnforcementModes> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: PLAN_ENFORCEMENT_KEY } });
    const next = { ...parseEnforcementModes(row?.value), ...patch };
    await this.prisma.systemSetting.upsert({
      where: { key: PLAN_ENFORCEMENT_KEY },
      create: { key: PLAN_ENFORCEMENT_KEY, value: next },
      update: { value: next },
    });
    this.modesCache = { at: Date.now(), modes: next };
    this.stateCache.clear();
    this.logger.log(`Plan enforcement modes set: ${JSON.stringify(next)}`);
    return next;
  }

  // ── State ────────────────────────────────────────────────────────────────

  /** A team's evaluated state; cached unless `fresh`. */
  async teamState(teamId: string, opts: { fresh?: boolean } = {}): Promise<TeamEnforcementState> {
    const now = Date.now();
    const cached = this.stateCache.get(teamId);
    if (!opts.fresh && cached && now - cached.at < STATE_TTL_MS) return cached.state;
    const modes = await this.modes();
    const sub = await this.prisma.subscription.findUnique({ where: { teamId }, include: { plan: true } });
    const usage = await this.usage.getTeamUsage(teamId);
    const state = evaluatePlanUsage((sub?.plan as any) ?? null, (usage as any) ?? null, modes, new Date());
    if (this.stateCache.size >= CACHE_MAX) this.stateCache.delete(this.stateCache.keys().next().value as string);
    this.stateCache.set(teamId, { at: now, state });
    return state;
  }

  /** Forget a team's cached state (after a plan change). */
  invalidate(teamId: string): void {
    this.stateCache.delete(teamId);
  }

  async teamForProject(projectId: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.projectTeam.get(projectId);
    if (cached && now - cached.at < PROJECT_TEAM_TTL_MS) return cached.teamId;
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { teamId: true } });
    const teamId = project?.teamId ?? null;
    if (this.projectTeam.size >= CACHE_MAX) this.projectTeam.delete(this.projectTeam.keys().next().value as string);
    this.projectTeam.set(projectId, { at: now, teamId });
    return teamId;
  }

  /** What the Billing page shows: modes and every metric, measured now. */
  async statusForTeam(teamId: string): Promise<TeamEnforcementState & { modes: EnforcementModes; upgradeUrl: string }> {
    const state = await this.teamState(teamId, { fresh: true });
    return { ...state, modes: await this.modes(), upgradeUrl: this.upgradeUrl() };
  }

  // ── Decisions ────────────────────────────────────────────────────────────

  /** API requests and egress (the usage middleware). */
  checkTraffic(teamId: string): Promise<PlanRefusal | null> {
    return this.decide(teamId, ['api_requests', 'egress']);
  }

  /** Writes that add data (the plan-gate interceptor). */
  checkDbWrite(teamId: string): Promise<PlanRefusal | null> {
    return this.decide(teamId, ['db_size']);
  }

  /** New sign-ups of a project's end users (the plan-gate interceptor). */
  checkSignup(teamId: string): Promise<PlanRefusal | null> {
    return this.decide(teamId, ['mau']);
  }

  private async decide(teamId: string, metrics: EnforcedMetric[]): Promise<PlanRefusal | null> {
    try {
      const modes = await this.modes();
      if (metrics.every((m) => modes[m] === 'off')) return null;
      const state = await this.teamState(teamId);
      if (state.exempt) return null;
      for (const metric of metrics) {
        const m = state.metrics.find((x) => x.metric === metric);
        if (!m || !m.wouldBlock) continue;
        if (m.mode === 'enforce') {
          this.logOnce(teamId, m, state, 'plan_limit_blocked');
          return this.refusal(teamId, m, state);
        }
        this.logOnce(teamId, m, state, 'plan_limit_would_block');
      }
      return null;
    } catch (err: any) {
      this.logger.warn(`Plan limit check failed for team ${teamId}, admitting: ${err?.message ?? err}`);
      return null;
    }
  }

  private logOnce(teamId: string, m: MetricState, state: TeamEnforcementState, event: string): void {
    const key = `${event}:${teamId}:${m.metric}`;
    const now = Date.now();
    const last = this.lastLog.get(key) ?? 0;
    if (now - last < LOG_EVERY_MS) return;
    if (this.lastLog.size >= CACHE_MAX) this.lastLog.clear();
    this.lastLog.set(key, now);
    this.logger.warn(
      JSON.stringify({
        event,
        teamId,
        metric: m.metric,
        mode: m.mode,
        plan: state.planName,
        current: m.current,
        limit: m.limit,
        percent: m.percent,
      }),
    );
  }

  upgradeUrl(): string {
    const app = (this.config?.get<string>('appUrl') || 'https://app.basefyio.com').replace(/\/+$/, '');
    return `${app}/dashboard/billing`;
  }

  async isTeamMember(teamId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.teamMember.findFirst({ where: { teamId, userId }, select: { id: true } });
    return !!row;
  }

  private refusal(teamId: string, m: MetricState, state: TeamEnforcementState): PlanRefusal {
    const plan = state.planDisplayName ?? 'current';
    const limit = formatFigure(m.limit, m.unit);
    const current = formatFigure(m.current, m.unit);
    const url = this.upgradeUrl();
    const base = {
      error: 'Plan Limit Exceeded',
      code: 'plan_limit_exceeded' as const,
      resource: m.metric,
      current: m.current,
      limit: m.limit,
      upgradeUrl: url,
    };
    switch (m.metric) {
      case 'api_requests':
      case 'egress': {
        const what = m.metric === 'api_requests' ? `${limit} API requests` : `${limit} of egress`;
        const retryAfterSeconds = secondsUntilNextMonth();
        return {
          status: 429,
          metric: m.metric,
          teamId,
          retryAfterSeconds,
          body: {
            statusCode: 429,
            ...base,
            message:
              `This organization has used ${current} of its ${what} for this month on the ${plan} plan, past the 10% grace. ` +
              `Requests are refused until the counter resets on the 1st (UTC) or the plan is upgraded: ${url}`,
          },
        };
      }
      case 'db_size':
        return {
          status: 402,
          metric: m.metric,
          teamId,
          body: {
            statusCode: 402,
            ...base,
            message:
              `This organization's databases use ${current}, over the ${plan} plan's ${limit} limit plus the 10% grace. ` +
              `Writes that add data are refused; reading, DELETE and TRUNCATE still work, so you can free space. Or upgrade: ${url}`,
          },
        };
      case 'mau':
        return {
          status: 402,
          metric: m.metric,
          teamId,
          body: {
            statusCode: 402,
            ...base,
            message:
              `This project's organization has reached its ${limit} monthly active users on the ${plan} plan, past the 10% grace. ` +
              `New sign-ups are refused until next month or an upgrade; existing users can still sign in.`,
          },
        };
    }
  }
}

export function secondsUntilNextMonth(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
