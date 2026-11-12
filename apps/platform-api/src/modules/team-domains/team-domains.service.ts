import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TeamsService } from '../teams/teams.service';
import {
  SUBDOMAIN_HOLD_DAYS,
  resolveBaseDomain,
  validateSubdomain,
  workspaceApiUrl,
  workspaceHost,
} from './subdomain.util';

/** The team a workspace address answers for. */
export interface ResolvedWorkspace {
  teamId: string;
  subdomain: string;
  /** An address the team gave up that is still on hold for it. */
  previous: boolean;
}

/** What the dashboard shows about a team's workspace address. */
export interface TeamDomainView {
  subdomain: string | null;
  updatedAt: Date | null;
  /** Domain addresses live under; null when this server has none configured. */
  baseDomain: string | null;
  /** Whether wildcard DNS, certificates and routing are in place on this server. */
  live: boolean;
  host: string | null;
  apiUrl: string | null;
  database: { host: string; port: number } | null;
  /** Earlier addresses that still answer for this team until they expire. */
  previous: { subdomain: string; host: string | null; expiresAt: Date }[];
  holdDays: number;
  canManage: boolean;
}

export type AvailabilityView =
  | { subdomain: string; available: true }
  | { subdomain: string; available: false; code: string; message: string };

/** Lookups a busy host makes on every request; a minute is short enough for a rename to land. */
const POSITIVE_TTL_MS = 60_000;
/** Unknown names are remembered briefly so a scan of random names does not reach the database each time. */
const NEGATIVE_TTL_MS = 15_000;
const PROJECT_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;
/**
 * A team that keeps renaming would otherwise sit on every name it ever used
 * for a month. Only its most recent few earlier addresses stay on hold.
 */
export const MAX_HOLDS_PER_TEAM = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expires: number;
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= now) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, expires: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    // Maps iterate in insertion order: drop the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires });
}

@Injectable()
export class TeamDomainsService {
  private readonly logger = new Logger(TeamDomainsService.name);
  private readonly workspaceCache = new Map<string, CacheEntry<ResolvedWorkspace | null>>();
  private readonly projectTeamCache = new Map<string, CacheEntry<string | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly teams: TeamsService,
  ) {}

  // ── Settings ──────────────────────────────────────────────

  /** TENANT_BASE_DOMAIN, or the parent of the public API host (api.<domain>). */
  baseDomain(): string | null {
    return resolveBaseDomain(
      this.config.get<string>('TENANT_BASE_DOMAIN'),
      this.config.get<string>('publicApiUrl'),
    );
  }

  /**
   * TENANT_SUBDOMAINS_LIVE=true once wildcard DNS, the wildcard certificate and
   * the catch-all route are in place. Until then an address can be claimed
   * but the dashboard says plainly that it does not answer yet.
   */
  live(): boolean {
    const raw = this.config.get<string | boolean>('TENANT_SUBDOMAINS_LIVE');
    return raw === true || String(raw ?? '').trim().toLowerCase() === 'true';
  }

  /** The pooler port customers connect to. */
  databasePort(): number {
    return this.config.get<number>('pgbouncer.externalPort') || 6432;
  }

  // ── Dashboard ─────────────────────────────────────────────

  async getForTeam(teamId: string, userId: string): Promise<TeamDomainView> {
    const member = await this.teams.assertMember(teamId, userId);
    const [team, holds] = await Promise.all([
      this.prisma.team.findUnique({
        where: { id: teamId },
        select: { subdomain: true, subdomainUpdatedAt: true },
      }),
      this.prisma.teamSubdomainHold.findMany({
        where: { teamId, expiresAt: { gt: new Date() } },
        orderBy: { releasedAt: 'desc' },
      }),
    ]);
    if (!team) throw new NotFoundException('Team not found');

    const base = this.baseDomain();
    const sub = team.subdomain;
    return {
      subdomain: sub,
      updatedAt: team.subdomainUpdatedAt,
      baseDomain: base,
      live: this.live(),
      host: sub && base ? workspaceHost(sub, base) : null,
      apiUrl: sub && base ? workspaceApiUrl(sub, base) : null,
      database: sub && base ? { host: workspaceHost(sub, base), port: this.databasePort() } : null,
      previous: holds.map((h) => ({
        subdomain: h.subdomain,
        host: base ? workspaceHost(h.subdomain, base) : null,
        expiresAt: h.expiresAt,
      })),
      holdDays: SUBDOMAIN_HOLD_DAYS,
      canManage: member.role === 'OWNER' || member.role === 'ADMIN',
    };
  }

  /** The address a team's projects can be reached at, when it has one and it answers. */
  async workspaceForTeam(
    teamId: string,
  ): Promise<{ subdomain: string; host: string; apiUrl: string; live: boolean } | null> {
    const base = this.baseDomain();
    if (!base) return null;
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { subdomain: true },
    });
    if (!team?.subdomain) return null;
    return {
      subdomain: team.subdomain,
      host: workspaceHost(team.subdomain, base),
      apiUrl: workspaceApiUrl(team.subdomain, base),
      live: this.live(),
    };
  }

  async checkAvailability(teamId: string, userId: string, input: unknown): Promise<AvailabilityView> {
    await this.teams.assertMember(teamId, userId);
    const check = validateSubdomain(input);
    if (!check.ok) {
      return { subdomain: check.value, available: false, code: check.code, message: check.message };
    }
    const blocked = await this.blockedFor(teamId, check.value);
    return blocked
      ? { subdomain: check.value, available: false, code: 'taken', message: blocked }
      : { subdomain: check.value, available: true };
  }

  /**
   * Claim or change the team's address. The address it had goes on hold for
   * SUBDOMAIN_HOLD_DAYS: it keeps answering for this team and nobody else can
   * take it, so apps still using it have time to move.
   */
  async claim(teamId: string, userId: string, input: unknown): Promise<TeamDomainView> {
    await this.teams.assertOwnerOrAdmin(teamId, userId);
    const check = validateSubdomain(input);
    if (!check.ok) {
      throw new BadRequestException({ code: 'SUBDOMAIN_INVALID', reason: check.code, message: check.message });
    }
    const value = check.value;

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, subdomain: true },
    });
    if (!team) throw new NotFoundException('Team not found');
    if (team.subdomain === value) return this.getForTeam(teamId, userId);

    const blocked = await this.blockedFor(teamId, value);
    if (blocked) throw new ConflictException({ code: 'SUBDOMAIN_TAKEN', message: blocked });

    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        // An expired hold, or this team's own, no longer stands in the way.
        await tx.teamSubdomainHold.deleteMany({
          where: { subdomain: value, OR: [{ teamId }, { expiresAt: { lte: now } }] },
        });
        const stillHeld = await tx.teamSubdomainHold.findUnique({ where: { subdomain: value } });
        if (stillHeld) {
          throw new ConflictException({ code: 'SUBDOMAIN_TAKEN', message: this.takenMessage(value) });
        }
        if (team.subdomain) await this.hold(tx, teamId, team.subdomain, now);
        await tx.team.update({
          where: { id: teamId },
          data: { subdomain: value, subdomainUpdatedAt: now },
        });
      });
    } catch (err: any) {
      // Two teams claiming the same free name at once: the unique index decides.
      if (err?.code === 'P2002') {
        throw new ConflictException({ code: 'SUBDOMAIN_TAKEN', message: this.takenMessage(value) });
      }
      throw err;
    }

    this.forget(value);
    if (team.subdomain) this.forget(team.subdomain);
    this.logger.log(
      `Team ${teamId} workspace address ${team.subdomain ? `changed ${team.subdomain} → ${value}` : `claimed: ${value}`} by ${userId}`,
    );
    return this.getForTeam(teamId, userId);
  }

  /** Give the address up. It stays on hold for this team like a rename. */
  async release(teamId: string, userId: string): Promise<TeamDomainView> {
    await this.teams.assertOwnerOrAdmin(teamId, userId);
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { subdomain: true },
    });
    if (!team) throw new NotFoundException('Team not found');
    const current = team.subdomain;
    if (!current) return this.getForTeam(teamId, userId);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.hold(tx, teamId, current, now);
      await tx.team.update({
        where: { id: teamId },
        data: { subdomain: null, subdomainUpdatedAt: now },
      });
    });
    this.forget(current);
    this.logger.log(`Team ${teamId} released workspace address ${current} (${userId})`);
    return this.getForTeam(teamId, userId);
  }

  /** Why `value` cannot be claimed by `teamId`, or null when it can. */
  private async blockedFor(teamId: string, value: string): Promise<string | null> {
    const [owner, hold] = await Promise.all([
      this.prisma.team.findUnique({ where: { subdomain: value }, select: { id: true } }),
      this.prisma.teamSubdomainHold.findUnique({ where: { subdomain: value } }),
    ]);
    if (owner && owner.id !== teamId) return this.takenMessage(value);
    if (hold && hold.teamId !== teamId && hold.expiresAt > new Date()) return this.takenMessage(value);
    return null;
  }

  private takenMessage(value: string): string {
    return `"${value}" is already taken. Choose another address.`;
  }

  /** Put `subdomain` on hold for `teamId`, keeping only its most recent few holds. */
  private async hold(tx: Prisma.TransactionClient, teamId: string, subdomain: string, now: Date): Promise<void> {
    const expiresAt = new Date(now.getTime() + SUBDOMAIN_HOLD_DAYS * DAY_MS);
    await tx.teamSubdomainHold.upsert({
      where: { subdomain },
      create: { subdomain, teamId, releasedAt: now, expiresAt },
      update: { teamId, releasedAt: now, expiresAt },
    });
    const holds = await tx.teamSubdomainHold.findMany({
      where: { teamId },
      orderBy: { releasedAt: 'desc' },
      select: { subdomain: true },
    });
    const surplus = holds.slice(MAX_HOLDS_PER_TEAM).map((h) => h.subdomain);
    if (surplus.length) {
      await tx.teamSubdomainHold.deleteMany({ where: { subdomain: { in: surplus } } });
      surplus.forEach((s) => this.forget(s));
    }
  }

  // ── Request routing ───────────────────────────────────────

  /** The team a workspace label answers for, or null. Cached briefly per process. */
  async resolveLabel(label: string): Promise<ResolvedWorkspace | null> {
    // A label no team could have claimed never reaches the database.
    if (!validateSubdomain(label).ok) return null;
    const now = Date.now();
    const cached = cacheGet(this.workspaceCache, label, now);
    if (cached !== undefined) return cached;

    const team = await this.prisma.team.findUnique({
      where: { subdomain: label },
      select: { id: true },
    });
    if (team) {
      const value = { teamId: team.id, subdomain: label, previous: false };
      cacheSet(this.workspaceCache, label, value, now + POSITIVE_TTL_MS);
      return value;
    }

    const hold = await this.prisma.teamSubdomainHold.findUnique({ where: { subdomain: label } });
    if (hold && hold.expiresAt.getTime() > now) {
      const value = { teamId: hold.teamId, subdomain: label, previous: true };
      cacheSet(this.workspaceCache, label, value, Math.min(now + POSITIVE_TTL_MS, hold.expiresAt.getTime()));
      return value;
    }

    cacheSet(this.workspaceCache, label, null, now + NEGATIVE_TTL_MS);
    return null;
  }

  /** The team a project belongs to, or null when there is no such project. */
  async teamOfProject(projectId: string): Promise<string | null> {
    const now = Date.now();
    const cached = cacheGet(this.projectTeamCache, projectId, now);
    if (cached !== undefined) return cached;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    const teamId = project?.teamId ?? null;
    cacheSet(this.projectTeamCache, projectId, teamId, now + PROJECT_TTL_MS);
    return teamId;
  }

  /** Drop a label from this process's cache after it changes hands. */
  private forget(label: string): void {
    this.workspaceCache.delete(label);
  }
}
