import { Injectable, NestMiddleware, Logger, Optional } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageService } from '../../modules/billing/usage.service';
import { PlanEnforcementService } from '../../modules/billing/plan-enforcement.service';
import { hashSecretKey, isSecretKey } from '../utils/secret-keys';

/**
 * The request path as the API routes it: a Supabase client with the bare host
 * as its base URL sends `/storage/v1/...`, `/auth/v1/...` or `/p/<id>/...`,
 * which main.ts maps onto `/api/...` (rewriteSupabasePaths) while
 * `originalUrl` keeps the bare form. Counting only `/api/` and `/rest/` missed
 * those requests, file downloads among them; the same mapping here counts them.
 */
export function normalizeApiPath(raw: string): string {
  let path = (raw || '').split('?')[0];
  if (/^\/(auth|rest|storage|realtime)\/v1(\/|$)/.test(path) || /^\/p\/[^/]+(\/|$)/.test(path)) {
    path = `/api${path}`;
  }
  const scoped = /^\/api\/p\/[^/]+(\/.*)?$/.exec(path);
  if (scoped) path = `/api${scoped[1] || '/'}`;
  return path;
}

/**
 * Never refused for API requests or egress, whatever the plan: health and
 * metrics, billing and payment (so a customer can always upgrade or pay),
 * the platform's own sign-in, and the project auth routes (an existing end
 * user must always be able to sign in and refresh their session; new sign-ups
 * are bounded by the MAU limit instead). The dashboard sends no API key and
 * no x-project-id, so it is never resolved to a project here at all.
 */
const TRAFFIC_EXEMPT_PREFIXES = [
  '/api/health',
  '/api/metrics',
  '/api/billing',
  '/api/auth/',
  '/api/rest/v1/auth/',
];

export function isTrafficExempt(path: string): boolean {
  const p = path.toLowerCase();
  return TRAFFIC_EXEMPT_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix));
}

interface ResolvedOwner {
  teamId: string;
  /** Known whenever the request named a project (header or API key). */
  projectId: string | null;
}

/**
 * Middleware that tracks API requests and bandwidth for billing.
 * Applied to public REST API routes (rest/v1/*).
 *
 * Resolves the owner from:
 * 1. x-project-id header → look up project → teamId + projectId
 * 2. apikey header → look up project by anonKey/serviceKey → teamId + projectId
 *
 * Usage is counted per team (plan quotas) and per project (the cost
 * breakdown under Billing).
 */
@Injectable()
export class UsageTrackingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UsageTrackingMiddleware.name);

  private static readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly MAX_CACHE_SIZE = 500;
  private static readonly EVICTION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private static readonly TSMART_FEED_PREFIX = '/api/integrations/tsmart/';

  private ownerCache = new Map<string, { owner: ResolvedOwner; expiresAt: number }>();

  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    @Optional() private readonly enforcement?: PlanEnforcementService,
  ) {
    // Periodically evict expired entries to prevent memory leak
    this.evictionTimer = setInterval(() => this.evictExpired(), UsageTrackingMiddleware.EVICTION_INTERVAL_MS);
    if (typeof (this.evictionTimer as any).unref === 'function') {
      (this.evictionTimer as any).unref();
    }
  }

  private evictExpired() {
    const now = Date.now();
    for (const [key, entry] of this.ownerCache) {
      if (entry.expiresAt <= now) {
        this.ownerCache.delete(key);
      }
    }
  }

  async use(req: Request, res: Response, next: NextFunction) {
    // Skip non-API routes — only track public REST/data API calls
    const path = normalizeApiPath(req.originalUrl || req.url);
    if (!path.startsWith('/api/')) {
      return next();
    }

    // The tsmart billing feed is platform-to-platform: it must never count
    // against a project, even if the caller sent x-project-id or apikey.
    // Lower-cased because Express matches routes case-insensitively.
    if (path.toLowerCase().startsWith(UsageTrackingMiddleware.TSMART_FEED_PREFIX)) {
      return next();
    }

    const owner = await this.resolveOwner(req);

    if (owner) {
      const { teamId, projectId } = owner;

      // Plan limits for API requests and egress. Off and warn never refuse;
      // enforce refuses past the limit plus the grace. Cached, and fails open.
      if (this.enforcement && !isTrafficExempt(path)) {
        const refusal = await this.enforcement.checkTraffic(teamId).catch(() => null);
        if (refusal) {
          if (refusal.retryAfterSeconds) res.setHeader('Retry-After', String(refusal.retryAfterSeconds));
          res.statusCode = refusal.status;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(refusal.body));
          return;
        }
      }

      this.usage.trackApiRequest(teamId, projectId).catch(() => {});

      const usageService = this.usage;
      let responseSize = 0;

      const originalWrite = res.write;
      (res as any).write = function (chunk: any, ...args: any[]) {
        if (chunk) {
          responseSize +=
            typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        }
        return originalWrite.apply(res, [chunk, ...args]);
      };

      const originalEnd = res.end;
      (res as any).end = function (chunk: any, ...args: any[]) {
        if (chunk) {
          responseSize +=
            typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        }

        const requestSize = req.headers['content-length']
          ? parseInt(req.headers['content-length'], 10)
          : 0;
        const totalBytes = requestSize + responseSize;

        if (totalBytes > 0) {
          usageService.trackBandwidth(teamId, totalBytes, projectId).catch(() => {});
        }

        return originalEnd.apply(res, [chunk, ...args]);
      };
    }

    next();
  }

  private async resolveOwner(req: Request): Promise<ResolvedOwner | null> {
    const projectId = req.headers['x-project-id'] as string;
    if (projectId) {
      return this.getOwnerForProject(projectId);
    }

    const apiKey = req.headers['apikey'] as string;
    if (apiKey) {
      return this.getOwnerByApiKey(apiKey);
    }

    return null;
  }

  private async getOwnerForProject(projectId: string): Promise<ResolvedOwner | null> {
    const cacheKey = `pid:${projectId}`;
    const cached = this.ownerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.owner;
    }

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, teamId: true },
      });
      if (project) {
        const owner = { teamId: project.teamId, projectId: project.id };
        this.setCacheEntry(cacheKey, owner);
        return owner;
      }
    } catch {
      this.logger.debug(`Failed to resolve owner for project ${projectId}`);
    }
    return null;
  }

  private async getOwnerByApiKey(apiKey: string): Promise<ResolvedOwner | null> {
    const cacheKey = `key:${apiKey.slice(0, 20)}`;
    const cached = this.ownerCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.owner;
    }

    try {
      // A secret key is stored only as its hash; any other key is compared as it is.
      const project = isSecretKey(apiKey)
        ? (
            await this.prisma.projectSecretKey.findFirst({
              where: { keyHash: hashSecretKey(apiKey), revokedAt: null, project: { status: 'ACTIVE' } },
              select: { project: { select: { id: true, teamId: true } } },
            })
          )?.project ?? null
        : await this.prisma.project.findFirst({
            where: {
              OR: [{ anonKey: apiKey }, { serviceKey: apiKey }],
              status: 'ACTIVE',
            },
            select: { id: true, teamId: true },
          });
      if (project) {
        const owner = { teamId: project.teamId, projectId: project.id };
        this.setCacheEntry(cacheKey, owner);
        return owner;
      }
    } catch {
      this.logger.debug('Failed to resolve owner by API key');
    }
    return null;
  }

  private setCacheEntry(key: string, owner: ResolvedOwner) {
    // Enforce max cache size — evict oldest entries when full
    if (this.ownerCache.size >= UsageTrackingMiddleware.MAX_CACHE_SIZE) {
      const firstKey = this.ownerCache.keys().next().value;
      if (firstKey) this.ownerCache.delete(firstKey);
    }
    this.ownerCache.set(key, {
      owner,
      expiresAt: Date.now() + UsageTrackingMiddleware.CACHE_TTL_MS,
    });
  }
}
