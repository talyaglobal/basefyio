import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { UsageService } from '../../modules/billing/usage.service';

/**
 * Middleware that tracks API requests and bandwidth for billing.
 * Applied to public REST API routes (rest/v1/*).
 *
 * Resolves team from:
 * 1. x-project-id header → look up project → get teamId
 * 2. apikey header → look up project by anonKey/serviceKey → get teamId
 */
@Injectable()
export class UsageTrackingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UsageTrackingMiddleware.name);

  private projectTeamCache = new Map<
    string,
    { teamId: string; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const teamId = await this.resolveTeamId(req);

    if (teamId) {
      this.usage.trackApiRequest(teamId).catch(() => {});

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
          usageService.trackBandwidth(teamId, totalBytes).catch(() => {});
        }

        return originalEnd.apply(res, [chunk, ...args]);
      };
    }

    next();
  }

  private async resolveTeamId(req: Request): Promise<string | null> {
    const projectId = req.headers['x-project-id'] as string;
    if (projectId) {
      return this.getTeamIdForProject(projectId);
    }

    const apiKey = req.headers['apikey'] as string;
    if (apiKey) {
      return this.getTeamIdByApiKey(apiKey);
    }

    return null;
  }

  private async getTeamIdForProject(
    projectId: string,
  ): Promise<string | null> {
    const cacheKey = `pid:${projectId}`;
    const cached = this.projectTeamCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.teamId;
    }

    try {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { teamId: true },
      });
      if (project) {
        this.projectTeamCache.set(cacheKey, {
          teamId: project.teamId,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        return project.teamId;
      }
    } catch {
      this.logger.debug(`Failed to resolve teamId for project ${projectId}`);
    }
    return null;
  }

  private async getTeamIdByApiKey(apiKey: string): Promise<string | null> {
    const cacheKey = `key:${apiKey.slice(0, 20)}`;
    const cached = this.projectTeamCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.teamId;
    }

    try {
      const project = await this.prisma.project.findFirst({
        where: {
          OR: [{ anonKey: apiKey }, { serviceKey: apiKey }],
          status: 'ACTIVE',
        },
        select: { teamId: true },
      });
      if (project) {
        this.projectTeamCache.set(cacheKey, {
          teamId: project.teamId,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        return project.teamId;
      }
    } catch {
      this.logger.debug('Failed to resolve teamId by API key');
    }
    return null;
  }
}
