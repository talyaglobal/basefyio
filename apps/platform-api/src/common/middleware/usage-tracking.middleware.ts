import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageService } from '../../modules/billing/usage.service';

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

  private ownerCache = new Map<string, { owner: ResolvedOwner; expiresAt: number }>();

  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
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
    const path = req.originalUrl || req.url;
    if (!path.startsWith('/rest/') && !path.startsWith('/api/')) {
      return next();
    }

    const owner = await this.resolveOwner(req);

    if (owner) {
      const { teamId, projectId } = owner;
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
      const project = await this.prisma.project.findFirst({
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
