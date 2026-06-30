import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';

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
  DATA_QUERY_EXECUTED: 'data_query.executed',
  DATA_QUERY_FAILED: 'data_query.failed',
  INTEGRATION_GITHUB_CONNECTED: 'integration.github_connected',
  INTEGRATION_GITHUB_DISCONNECTED: 'integration.github_disconnected',
  INTEGRATION_VERCEL_CONNECTED: 'integration.vercel_connected',
  INTEGRATION_VERCEL_DISCONNECTED: 'integration.vercel_disconnected',
  AUTH_CONFIG_UPDATED: 'auth.config_updated',
  TABLE_CREATED: 'table.created',
  TABLE_DROPPED: 'table.dropped',
  TABLE_ROW_INSERTED: 'table.row_inserted',
  TABLE_ROW_UPDATED: 'table.row_updated',
  TABLE_ROW_DELETED: 'table.row_deleted',
  TABLE_ROWS_DEDUPLICATED: 'table.rows_deduplicated',
  TABLE_COLUMN_ADDED: 'table.column_added',
  TABLE_COLUMN_UPDATED: 'table.column_updated',
  TABLE_COLUMN_DELETED: 'table.column_deleted',
  TABLE_FK_ADDED: 'table.foreign_key_added',
  TABLE_FK_DELETED: 'table.foreign_key_deleted',
  DATA_IMPORT_STARTED: 'data_import.started',
  DATA_IMPORT_COMPLETED: 'data_import.completed',
  DATA_IMPORT_FAILED: 'data_import.failed',
  PROJECT_EXPORT_STARTED: 'project_export.started',
  PROJECT_BACKUP_RESTORE_STARTED: 'project_backup_restore.started',
  PROJECT_RLS_BOOTSTRAP: 'project.rls_bootstrap',
  STORAGE_BUCKET_CREATED: 'storage.bucket_created',
  STORAGE_BUCKET_UPDATED: 'storage.bucket_updated',
  STORAGE_BUCKET_DELETED: 'storage.bucket_deleted',
  STORAGE_OBJECT_UPLOADED: 'storage.object_uploaded',
  STORAGE_OBJECT_DELETED: 'storage.object_deleted',
  AUTH_USER_CREATED: 'auth.user_created',
  AUTH_USER_UPDATED: 'auth.user_updated',
  AUTH_USER_PASSWORD_RESET: 'auth.user_password_reset',
  AUTH_USER_DELETED: 'auth.user_deleted',
  COLLECTION_CREATED: 'collection.created',
  COLLECTION_DROPPED: 'collection.dropped',
  COLLECTION_DOCUMENT_INSERTED: 'collection.document_inserted',
  COLLECTION_DOCUMENT_UPDATED: 'collection.document_updated',
  COLLECTION_DOCUMENT_REPLACED: 'collection.document_replaced',
  COLLECTION_DOCUMENT_DELETED: 'collection.document_deleted',
} as const;

export type ProjectActivityKindValue =
  (typeof ProjectActivityKind)[keyof typeof ProjectActivityKind];

@Injectable()
export class ProjectActivityService {
  private readonly logger = new Logger(ProjectActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
  ) {}

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
      const created = await this.prisma.projectActivityLog.create({
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
      try {
        const project = await this.prisma.project.findUnique({
          where: { id: projectId },
          select: { teamId: true },
        });
        await this.realtime.publish({
          entityType: 'project_activity',
          action: 'activity_appended',
          entityId: created.id,
          actorUserId: params.userId ?? undefined,
          projectId,
          teamId: project?.teamId,
          payload: {
            kind: params.kind,
            title: params.title,
            detail: params.detail ?? null,
          },
        });
      } catch {
        // Realtime publish failures should not break activity logging.
      }
    } catch (err: any) {
      this.logger.warn(
        `project activity log failed (${params.kind}): ${err.message}`,
      );
    }
  }

  /**
   * Paginated activity feed for a single project. The DB happily holds tens of
   * thousands of rows per project (every table edit, every SQL exec, every
   * auth tweak) and the Project Logs page must be able to scroll back to the
   * very first event — so we accept `page`/`limit` instead of a hard cap and
   * return `total` so the UI can render real pagination.
   */
  async listForProject(
    projectId: string,
    userId: string,
    opts: { page?: number; limit?: number } = {},
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');

    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new NotFoundException('Project not found');

    // Clamp to sane bounds. 500 is generous — anyone wanting more uses paging.
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const page = Math.max(opts.page ?? 1, 1);
    const skip = (page - 1) * limit;

    const [total, items] = await Promise.all([
      this.prisma.projectActivityLog.count({ where: { projectId } }),
      this.prisma.projectActivityLog.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          kind: true,
          title: true,
          detail: true,
          metadata: true,
          createdAt: true,
          userId: true,
        },
      }),
    ]);

    const userIds = Array.from(
      new Set(items.map((item) => item.userId).filter((v): v is string => !!v)),
    );
    const users =
      userIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          })
        : [];
    const userMap = new Map(
      users.map((u) => [
        u.id,
        [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email,
      ]),
    );

    return {
      items: items.map((item) => ({
        ...item,
        actorName: item.userId ? userMap.get(item.userId) || item.userId : 'System',
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }
}
