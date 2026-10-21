import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { Client } from 'pg';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectsService } from '../projects.service';
import { ProjectActivityKind, ProjectActivityService } from '../project-activity.service';
import { EntitlementService } from '../../entitlement/entitlement.service';
import { EntitlementKey } from '../../entitlement/entitlement-key';
import { RealtimeEventsService } from '../../../common/realtime/realtime-events.service';
import { envInt } from '../backups/backup-env';
import { BRANCH_NAME_PATTERN, CreatePreviewBranchDto } from './dto/create-preview-branch.dto';
import { BranchDataMode, BranchSyncStatus, previewBranchOf } from './preview-branch';

const execFileAsync = promisify(execFile);

export { previewBranchOf } from './preview-branch';
export type { PreviewBranch, BranchDataMode, BranchSyncStatus } from './preview-branch';

/** A branch left "pending" this long was interrupted by a restart; it will never finish. */
const STALE_SYNC_MS = 2 * 60 * 60 * 1000;

export interface PreviewBranchListItem {
  id: string;
  name: string;
  slug: string;
  status: string;
  branchName: string;
  dataMode: BranchDataMode | null;
  syncStatus: BranchSyncStatus | null;
  syncError: string | null;
  createdAt: string;
  createdBy: string | null;
}

interface DbTarget {
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
}

/**
 * Preview branches: a child project with its own database, realm and keys,
 * populated from the parent's schema (and optionally its data). A branch is
 * disposable — it is meant for trying a migration or a feature against real
 * structure without touching the project people depend on.
 */
@Injectable()
export class ProjectBranchService {
  private readonly logger = new Logger(ProjectBranchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly entitlement: EntitlementService,
    private readonly activity: ProjectActivityService,
    private readonly realtime: RealtimeEventsService,
  ) {}

  get limitPerProject(): number {
    return envInt('BRANCH_LIMIT_PER_PROJECT', 3);
  }

  get maxDbBytesForFullCopy(): number {
    return envInt('BRANCH_MAX_DB_MB', 2048) * 1024 * 1024;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async createPreviewBranch(parentId: string, userId: string, dto: CreatePreviewBranchDto) {
    const branchName = (dto.name ?? '').trim();
    if (!BRANCH_NAME_PATTERN.test(branchName)) {
      throw new BadRequestException(
        'Branch name must be 2-40 characters of lowercase letters, digits and hyphens, starting and ending with a letter or digit',
      );
    }
    const dataMode: BranchDataMode = dto.dataMode === 'full' ? 'full' : 'schema';

    // Membership check; then the raw row, because findOne swaps the DB host
    // for the external pooler address and pg_dump needs the real one.
    await this.projectsService.findOne(parentId, userId);
    const parent = await this.prisma.project.findUnique({ where: { id: parentId } });
    if (!parent || parent.status === 'DELETED') throw new NotFoundException('Project not found');

    if (parent.status !== 'ACTIVE') {
      throw new BadRequestException('Only an active project can be branched');
    }
    if (parent.databaseType !== 'RELATIONAL') {
      throw new BadRequestException('Preview branches are available for PostgreSQL projects only');
    }
    if (parent.parentProjectId) {
      throw new BadRequestException(
        'A preview branch cannot be branched again; create the branch from the parent project instead',
      );
    }
    const dedicated = await this.prisma.projectInfrastructure.findUnique({ where: { projectId: parentId } });
    if (dedicated) {
      throw new BadRequestException('Branching is not yet available for projects on a dedicated database');
    }

    await this.entitlement.assertCan(parentId, EntitlementKey.PROJECT_BRANCHES);

    const live = await this.prisma.project.count({
      where: { parentProjectId: parentId, status: { notIn: ['DELETED', 'DEACTIVATED'] } },
    });
    if (live >= this.limitPerProject) {
      throw new ConflictException(
        `This project already has ${live} preview branch(es); the limit is ${this.limitPerProject}. Delete one to create another.`,
      );
    }

    // The unique constraint covers trashed branches too, and a collision there
    // would surface only after the database and realm were provisioned.
    const taken = await this.prisma.project.findFirst({
      where: { parentProjectId: parentId, branchName },
      select: { id: true, status: true },
    });
    if (taken) {
      throw new ConflictException(
        taken.status === 'DELETED'
          ? `A branch named "${branchName}" is still in the trash; purge it or pick another name`
          : `A branch named "${branchName}" already exists for this project`,
      );
    }

    if (dataMode === 'full') {
      const bytes = await this.databaseSize(parent);
      if (bytes > this.maxDbBytesForFullCopy) {
        throw new BadRequestException(
          `The database is ${Math.round(bytes / 1024 / 1024)} MB; full-data branches are limited to ` +
            `${Math.round(this.maxDbBytesForFullCopy / 1024 / 1024)} MB. Create a schema-only branch instead.`,
        );
      }
    }

    const name = `${parent.name} [${branchName}]`.slice(0, 64);
    const branch = await this.projectsService.create(
      {
        name,
        description: `Preview branch "${branchName}" of ${parent.name}`,
        teamId: parent.teamId,
      },
      userId,
      'BRANCH',
      { branch: { parentProjectId: parentId, branchName, dataMode } },
    );

    await this.activity.append(parentId, {
      userId,
      kind: ProjectActivityKind.PROJECT_BRANCH_CREATED,
      title: `Preview branch "${branchName}" created`,
      detail:
        dataMode === 'full'
          ? 'Schema and data are being copied from this project'
          : 'Schema is being copied from this project',
      metadata: { branchId: branch.id, branchName, dataMode },
    });

    void this.populateBranch(parent, branch, dataMode, userId).catch((err: any) =>
      this.logger.error(`Preview branch ${branch.id} population crashed: ${err?.message}`),
    );

    return {
      project: {
        id: branch.id,
        name: branch.name,
        slug: branch.slug,
        status: branch.status,
        teamId: branch.teamId,
        createdAt: branch.createdAt,
      },
      previewBranch: previewBranchOf({
        ...branch,
        parent: { id: parent.id, name: parent.name, slug: parent.slug },
      }),
    };
  }

  /**
   * `pg_dump | pg_restore` from parent to branch, in the background. The
   * branch row carries the outcome in branchSyncStatus / branchSyncError.
   */
  async populateBranch(
    parent: DbTarget & { id: string; teamId: string },
    branch: DbTarget & { id: string },
    dataMode: BranchDataMode,
    userId: string,
  ): Promise<void> {
    const tmp = await mkdtemp(join(tmpdir(), `bf-branch-${branch.id.slice(0, 8)}-`));
    const dumpPath = join(tmp, 'branch.dump');
    const warnings: string[] = [];
    let status: BranchSyncStatus = 'ready';
    let error: string | null = null;

    try {
      await execFileAsync(
        'pg_dump',
        [
          '--host', parent.dbHost,
          '--port', String(parent.dbPort),
          '--username', parent.dbUser,
          '--dbname', parent.dbName,
          '--format=custom',
          '--no-owner',
          '--no-acl',
          ...(dataMode === 'schema' ? ['--schema-only'] : []),
          '-f', dumpPath,
        ],
        {
          env: { ...process.env, PGPASSWORD: parent.dbPassword, PGCONNECT_TIMEOUT: '10' },
          maxBuffer: 16 * 1024 * 1024,
        },
      ).catch((err: any) => {
        throw new Error(`pg_dump failed: ${lastLines(String(err?.stderr ?? '')) || err?.message}`);
      });

      try {
        await execFileAsync(
          'pg_restore',
          [
            '--host', branch.dbHost,
            '--port', String(branch.dbPort),
            '--username', branch.dbUser,
            '--dbname', branch.dbName,
            '--no-owner',
            '--no-acl',
            // The bootstrap already installed auth.* helpers; let the parent's copy replace them instead of colliding.
            '--clean',
            '--if-exists',
            dumpPath,
          ],
          {
            env: { ...process.env, PGPASSWORD: branch.dbPassword, PGCONNECT_TIMEOUT: '10' },
            maxBuffer: 16 * 1024 * 1024,
          },
        );
      } catch (err: any) {
        // Exit code 1 means pg_restore finished but ignored some errors — the
        // usual case is an object the RLS bootstrap had already created.
        const stderr = String(err?.stderr ?? '');
        const ignored = stderr.match(/errors ignored on restore: (\d+)/);
        if (err?.code === 1 && ignored) {
          warnings.push(`pg_restore ignored ${ignored[1]} error(s), typically objects the project bootstrap had already created`);
        } else {
          throw new Error(`pg_restore failed: ${lastLines(stderr) || err?.message}`);
        }
      }

      // --no-acl carried no grants; the bootstrap puts the anon/authenticated/service_role privileges back.
      await this.projectsService
        .ensureRlsBootstrap(branch.id)
        .catch((err: any) => warnings.push(`RLS bootstrap re-apply failed: ${err?.message}`));
    } catch (err: any) {
      status = 'failed';
      error = String(err?.message || err).slice(0, 1000);
      this.logger.error(`Preview branch ${branch.id} could not be populated: ${error}`);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }

    await this.prisma.project
      .update({
        where: { id: branch.id },
        data: {
          branchSyncStatus: status,
          branchSyncError: error ?? (warnings.length ? warnings.join('; ') : null),
        },
      })
      .catch((err: any) => this.logger.error(`Preview branch ${branch.id} status not written: ${err?.message}`));

    await this.activity.append(branch.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: status === 'ready' ? 'Preview branch populated from its parent' : 'Preview branch population failed',
      detail: error ?? (warnings.length ? warnings.join('; ') : `${dataMode === 'full' ? 'Schema and data' : 'Schema'} copied`),
      metadata: { parentProjectId: parent.id, dataMode, status },
    });

    const members = await this.prisma.teamMember.findMany({
      where: { teamId: parent.teamId },
      select: { userId: true },
    });
    await this.realtime
      .publish({
        entityType: 'project',
        action: 'updated',
        entityId: branch.id,
        actorUserId: userId,
        teamId: parent.teamId,
        userIds: members.map((m) => m.userId),
        payload: { branchSyncStatus: status, parentProjectId: parent.id },
      })
      .catch(() => undefined);
  }

  // ── List / delete ──────────────────────────────────────────────────────────

  async listPreviewBranches(parentId: string, userId: string): Promise<PreviewBranchListItem[]> {
    await this.projectsService.findOne(parentId, userId);
    const rows = await this.prisma.project.findMany({
      where: { parentProjectId: parentId, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        branchName: true,
        branchDataMode: true,
        branchSyncStatus: true,
        branchSyncError: true,
        createdAt: true,
        createdBy: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      status: r.status,
      branchName: r.branchName ?? '',
      dataMode: (r.branchDataMode as BranchDataMode | null) ?? null,
      syncStatus: (r.branchSyncStatus as BranchSyncStatus | null) ?? null,
      syncError: r.branchSyncError,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
    }));
  }

  /** Soft-delete a branch through the ordinary project trash (24 h window, hourly purge). */
  async deletePreviewBranch(parentId: string, branchId: string, userId: string) {
    await this.projectsService.findOne(parentId, userId);
    const child = await this.prisma.project.findFirst({
      where: { id: branchId, parentProjectId: parentId, status: { not: 'DELETED' } },
      select: { id: true, name: true, branchName: true },
    });
    if (!child) throw new NotFoundException('Preview branch not found');

    await this.projectsService.remove(branchId, userId, {
      reasonCode: 'preview_branch_deleted',
      reasonLabel: 'Preview branch deleted',
    });

    // Free the name for a new branch; the trashed row keeps a traceable label.
    await this.prisma.project
      .update({
        where: { id: branchId },
        data: { branchName: `${child.branchName ?? 'branch'}_del${Date.now()}`.slice(0, 63) },
      })
      .catch(() => undefined);

    await this.activity.append(parentId, {
      userId,
      kind: ProjectActivityKind.PROJECT_BRANCH_DELETED,
      title: `Preview branch "${child.branchName}" moved to trash`,
      metadata: { branchId },
    });

    return { message: 'Preview branch moved to trash' };
  }

  /** A branch stuck in "pending" was interrupted by a restart; say so instead of spinning forever. */
  @Cron(CronExpression.EVERY_HOUR)
  async failStaleBranchSyncs(): Promise<number> {
    const res = await this.prisma.project.updateMany({
      where: {
        branchSyncStatus: 'pending',
        createdAt: { lt: new Date(Date.now() - STALE_SYNC_MS) },
      },
      data: {
        branchSyncStatus: 'failed',
        branchSyncError: 'Population was interrupted by a server restart; delete this branch and create it again.',
      },
    });
    if (res.count > 0) this.logger.warn(`Marked ${res.count} stale preview branch sync(s) as failed`);
    return res.count;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async databaseSize(target: DbTarget): Promise<number> {
    const client = new Client({
      host: target.dbHost,
      port: target.dbPort,
      user: target.dbUser,
      password: target.dbPassword,
      database: target.dbName,
      connectionTimeoutMillis: 10_000,
    });
    await client.connect();
    try {
      const res = await client.query<{ bytes: string }>('select pg_database_size(current_database())::bigint as bytes');
      return Number(res.rows[0]?.bytes ?? 0);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

function lastLines(text: string, n = 5): string {
  return text.trim().split('\n').slice(-n).join('\n').slice(0, 800);
}
