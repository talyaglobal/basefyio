import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** Stored in DB `kind` — keep lowercase dot notation for API stability */
export const ProjectActivityKind = {
  SUPABASE_IMPORT_COMPLETED: 'supabase_import.completed',
  SUPABASE_IMPORT_FAILED: 'supabase_import.failed',
  SUPABASE_IMPORT_CANCELLED: 'supabase_import.cancelled',
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_DELETED: 'project.deleted',
  PROJECT_RESTORED: 'project.restored',
  PROJECT_PERMANENT_DELETE: 'project.permanent_delete',
  PROJECT_MOVED_TEAM: 'project.moved_team',
  SQL_EXECUTED: 'sql.executed',
  SQL_FAILED: 'sql.failed',
  INTEGRATION_GITHUB_CONNECTED: 'integration.github_connected',
  INTEGRATION_GITHUB_DISCONNECTED: 'integration.github_disconnected',
  INTEGRATION_VERCEL_CONNECTED: 'integration.vercel_connected',
  INTEGRATION_VERCEL_DISCONNECTED: 'integration.vercel_disconnected',
  AUTH_CONFIG_UPDATED: 'auth.config_updated',
} as const;

export type ProjectActivityKindValue =
  (typeof ProjectActivityKind)[keyof typeof ProjectActivityKind];

@Injectable()
export class ProjectActivityService {
  private readonly logger = new Logger(ProjectActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async append(
    projectId: string,
    params: {
      userId?: string | null;
      kind: ProjectActivityKindValue;
      title: string;
      detail?: string | null;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    try {
      await this.prisma.projectActivityLog.create({
        data: {
          projectId,
          userId: params.userId ?? null,
          kind: params.kind,
          title: params.title.slice(0, 512),
          detail: params.detail?.slice(0, 8000) ?? null,
          ...(params.metadata != null
            ? { metadata: params.metadata }
            : {}),
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `project activity log failed (${params.kind}): ${err.message}`,
      );
    }
  }

  async listForProject(projectId: string, userId: string, limit = 80) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');

    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new NotFoundException('Project not found');

    const take = Math.min(Math.max(limit, 1), 200);
    const items = await this.prisma.projectActivityLog.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        kind: true,
        title: true,
        detail: true,
        metadata: true,
        createdAt: true,
        userId: true,
      },
    });

    return { items };
  }
}
