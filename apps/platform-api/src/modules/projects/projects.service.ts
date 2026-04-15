import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { PgBouncerService } from '../pgbouncer/pgbouncer.service';
import { QuotaService } from '../billing/quota.service';
import { UsageService } from '../billing/usage.service';
import { InfrastructureService } from '../infrastructure/infrastructure.service';
import { CreateProjectDto } from './dto/create-project.dto';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
    private readonly config: ConfigService,
    private readonly pgbouncer: PgBouncerService,
    private readonly activity: ProjectActivityService,
    private readonly quota: QuotaService,
    private readonly usageService: UsageService,
    private readonly infra: InfrastructureService,
  ) {}

  async create(
    dto: CreateProjectDto & { teamId: string },
    userId: string,
    importSource: 'MANUAL' | 'SUPABASE' | 'ZIP' = 'MANUAL',
  ) {
    const normalizedName = dto.name.trim();
    if (!normalizedName) {
      throw new BadRequestException('Project name is required');
    }
    const existingByName = await this.prisma.project.findFirst({
      where: {
        name: {
          equals: normalizedName,
          mode: 'insensitive',
        },
        teamId: dto.teamId,
        status: { not: 'DELETED' },
      },
      select: { id: true, name: true },
    });
    if (existingByName) {
      throw new BadRequestException('A project with this name already exists in this team');
    }

    await this.assertTeamMember(dto.teamId, userId);
    await this.quota.assertCanCreateProject(dto.teamId);

    // Keep provisioning architecture consistent across plans to avoid migration issues
    // during plan upgrades/downgrades (free -> pro/business and vice versa).
    const needsDedicatedDb = this.infra.isEnabled() || (await this.quota.shouldUseDedicatedDb(dto.teamId));

    const projectId = randomUUID();
    const slug = await this.uniqueSlug(this.toSlug(normalizedName));
    const dbName = `kb_${slug}`;
    const dbUser = `kb_user_${slug}`;
    const dbPassword = randomBytes(24).toString('base64url');
    const realmName = `kb-${slug}`;
    const dbHost = this.config.get<string>('database.host')!;
    const dbPort = this.config.get<number>('database.port')!;

    let actualDbHost = dbHost;
    let actualDbPort = dbPort;
    let actualAdminUser: string | undefined;
    let actualAdminPassword: string | undefined;

    if (needsDedicatedDb && this.infra.isEnabled()) {
      try {
        const plan = await this.quota.getTeamPlan(dto.teamId);
        const pgResult = await this.infra.provisionPostgres({
          projectId,
          projectSlug: slug,
          memoryMb: plan?.dbMemoryMb || 1024,
          cpuMillis: plan?.dbCpuMillis || 1000,
        });
        actualDbHost = pgResult.host;
        actualDbPort = pgResult.port;
        actualAdminUser = pgResult.adminUser;
        actualAdminPassword = pgResult.adminPassword;
      } catch (err: any) {
        this.logger.warn(`Failed to provision dedicated Postgres, falling back to shared: ${err.message}`);
      }
    }

    if (actualAdminUser && actualAdminPassword) {
      await this.createDatabaseOnHost(dbName, actualDbHost, actualDbPort, actualAdminUser, actualAdminPassword);
      await this.createDatabaseUserOnHost(dbUser, dbPassword, dbName, actualDbHost, actualDbPort, actualAdminUser, actualAdminPassword);
    } else {
      await this.createDatabase(dbName);
      await this.createDatabaseUser(dbUser, dbPassword, dbName);
    }

    let anonKey: string;
    let serviceKey: string;

    try {
      await this.keycloak.createRealm(realmName);
      const clients = await this.keycloak.createClients(realmName);
      anonKey = clients.anonKey;
      serviceKey = clients.serviceKey;
    } catch (err) {
      await this.dropDatabaseUser(dbUser);
      await this.dropDatabase(dbName);
      this.logger.error('Keycloak realm creation failed, rolling back', err);
      throw new InternalServerErrorException(
        'Failed to provision authentication realm',
      );
    }

    const project = await this.prisma.project.create({
      data: {
        id: projectId,
        name: normalizedName,
        slug,
        description: dto.description,
        dbName,
        dbHost: actualDbHost,
        dbPort: actualDbPort,
        dbUser,
        dbPassword,
        keycloakRealm: realmName,
        anonKey,
        serviceKey,
        teamId: dto.teamId,
        createdBy: userId,
        importSource,
      },
    });

    this.logger.log(`Project "${project.name}" created (${project.id})`);

    await this.activity.append(project.id, {
      userId,
      kind: ProjectActivityKind.PROJECT_CREATED,
      title: `Project created: ${project.name}`,
    });

    this.usageService.incrementProjectCount(dto.teamId).catch(() => {});

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    return project;
  }

  async findAll(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);

    const projects = await this.prisma.project.findMany({
      where: { teamId, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        folderId: true,
        folder: { select: { id: true, name: true, color: true } },
        tags: {
          select: {
            tag: { select: { id: true, name: true, color: true } },
          },
        },
        createdBy: true,
        dbName: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const creatorIds = Array.from(
      new Set(
        projects
          .map((project) => project.createdBy)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const creators =
      creatorIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: creatorIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          })
        : [];
    const creatorById = new Map(
      creators.map((creator) => {
        const fullName = [creator.firstName, creator.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        const displayName = fullName || creator.email;
        return [creator.id, displayName] as const;
      }),
    );

    const dbSizeByName = new Map<string, number>();
    const dbNames = Array.from(new Set(projects.map((project) => project.dbName)));
    if (dbNames.length > 0) {
      try {
        const pool = this.getAdminPool();
        const client = await pool.connect();
        try {
          const result = await client.query<{
            datname: string;
            size_bytes: string;
          }>(
            `
              SELECT datname, pg_database_size(datname)::bigint AS size_bytes
              FROM pg_database
              WHERE datname = ANY($1::text[])
            `,
            [dbNames],
          );
          for (const row of result.rows) {
            dbSizeByName.set(row.datname, Number(row.size_bytes));
          }
        } finally {
          client.release();
          await pool.end();
        }
      } catch (err: any) {
        this.logger.warn(`Failed to resolve project DB sizes: ${err.message}`);
      }
    }

    return projects.map(({ createdBy, dbName, ...project }) => ({
      ...project,
      createdBy,
      createdByName: createdBy ? creatorById.get(createdBy) ?? null : null,
      projectSizeBytes: dbSizeByName.get(dbName) ?? null,
    }));
  }

  async update(
    id: string,
    userId: string,
    data: { folderId?: string | null; tags?: string[]; name?: string; description?: string },
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    const updateData: any = {};
    if (data.folderId !== undefined) updateData.folderId = data.folderId;
    if (data.name !== undefined && data.name.trim()) updateData.name = data.name.trim();
    if (data.description !== undefined) updateData.description = data.description || null;

    const [updatedProject] = await this.prisma.$transaction(async (tx) => {
      const p = await tx.project.update({ where: { id }, data: updateData });

      if (data.tags !== undefined) {
        await tx.projectTagAssignment.deleteMany({ where: { projectId: id } });
        if (data.tags.length > 0) {
          await tx.projectTagAssignment.createMany({
            data: data.tags.map((tagId) => ({ projectId: id, tagId })),
          });
        }
      }

      return [p];
    });

    const changes: string[] = [];
    if (data.name !== undefined) changes.push('name');
    if (data.description !== undefined) changes.push('description');
    if (data.folderId !== undefined) changes.push('folder');
    if (data.tags !== undefined) changes.push('tags');
    if (changes.length > 0) {
      await this.activity.append(id, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Project updated',
        detail: `Changed: ${changes.join(', ')}`,
        metadata: { fields: changes },
      });
    }

    return this.prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        folderId: true,
        folder: { select: { id: true, name: true, color: true } },
        tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async rotateDatabasePassword(
    projectId: string,
    userId: string,
    nextPassword?: string,
  ) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);

    const password = nextPassword?.trim() || randomBytes(24).toString('base64url');
    this.assertStrongDbPassword(password);

    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitizedUser = project.dbUser.replace(/[^a-z0-9_]/g, '');

    try {
      await client.query(
        `ALTER USER "${sanitizedUser}" WITH PASSWORD '${password.replace(/'/g, "''")}'`,
      );

      await this.prisma.project.update({
        where: { id: project.id },
        data: { dbPassword: password },
      });

      await this.activity.append(project.id, {
        userId,
        kind: ProjectActivityKind.PROJECT_UPDATED,
        title: 'Database password rotated',
      });
    } catch (err: any) {
      throw new InternalServerErrorException(
        `Failed to rotate database password: ${err.message}`,
      );
    } finally {
      client.release();
      await pool.end();
    }

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    return { password };
  }

  /**
   * Raw DB + Keycloak fields for the import worker (internal host/port as stored — not PgBouncer external).
   */
  async getProjectForSupabaseImport(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertTeamMember(project.teamId, userId);
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      teamId: project.teamId,
      dbHost: project.dbHost,
      dbPort: project.dbPort,
      dbUser: project.dbUser,
      dbPassword: project.dbPassword,
      dbName: project.dbName,
      keycloakRealm: project.keycloakRealm,
    };
  }

  async findOne(id: string, userId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, status: { not: 'DELETED' } },
    });

    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      await this.assertTeamMember(project.teamId, userId);
    }

    const { githubToken, vercelToken, ...safe } = project;

    const externalHost = this.config.get<string>('pgbouncer.externalHost') || project.dbHost;
    const externalPort = this.config.get<number>('pgbouncer.externalPort') || project.dbPort;

    return {
      ...safe,
      dbHost: externalHost,
      dbPort: externalPort,
      github: project.githubOwner && project.githubRepo
        ? { connected: true, owner: project.githubOwner, repo: project.githubRepo, branch: project.githubBranch || 'main', repoUrl: `https://github.com/${project.githubOwner}/${project.githubRepo}` }
        : { connected: false },
      vercel: project.vercelProjectId
        ? { connected: true, projectId: project.vercelProjectId }
        : { connected: false },
    };
  }

  async moveToTeam(projectId: string, targetTeamId: string, userId: string) {
    // Load project and verify caller is a member of source team
    const project = await this.findOne(projectId, userId);

    // Caller must be OWNER of the source team
    const sourceMembership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!sourceMembership || sourceMembership.role !== 'OWNER') {
      throw new ForbiddenException('Only the source team owner can move projects');
    }

    // Caller must be a member of the target team
    const targetMembership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: targetTeamId, userId } },
    });
    if (!targetMembership) {
      throw new ForbiddenException('You are not a member of the target team');
    }

    if (project.teamId === targetTeamId) {
      throw new ForbiddenException('Project is already in this team');
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        teamId: targetTeamId,
        // Clear folder assignment since folders are team-specific
        folderId: null,
      },
    });

    this.logger.log(
      `Project "${project.name}" moved from team ${project.teamId} to team ${targetTeamId} by user ${userId}`,
    );

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.PROJECT_MOVED_TEAM,
      title: 'Project moved to another team',
      detail: `From team ${project.teamId} to ${targetTeamId}`,
      metadata: { fromTeamId: project.teamId, toTeamId: targetTeamId },
    });

    return { message: 'Project moved successfully' };
  }

  async remove(
    id: string,
    userId: string,
    reason?: {
      reasonCode?: string;
      reasonLabel?: string;
      details?: string;
    },
  ) {
    const project = await this.findOne(id, userId);

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this team');
    }

    const isCreator = project.createdBy === userId;
    if (membership.role !== 'OWNER' && !isCreator) {
      throw new ForbiddenException('You can only delete projects you created');
    }

    const deletedName = await this.uniqueDeletedName(project.name);
    const deletedSlug = await this.uniqueDeletedSlug(project.slug);

    // Derive archived resource names (safe for DB identifier length limits)
    const suffix = `_del${Date.now()}`;
    const archivedDbName = `${project.dbName}${suffix}`.slice(0, 63);
    const archivedDbUser = `${project.dbUser}${suffix}`.slice(0, 63);
    const archivedRealm = `${project.keycloakRealm}${suffix}`.slice(0, 255);

    // Rename DB + user so the original names are free for re-import immediately.
    // All data (tables, auth users, storage) remains intact for a potential restore.
    await this.renameDatabase(project.dbName, archivedDbName);

    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      await client.query(`ALTER USER "${project.dbUser.replace(/[^a-z0-9_]/g, '')}" RENAME TO "${archivedDbUser.replace(/[^a-z0-9_]/g, '')}"`);
    } catch (err: any) {
      this.logger.warn(`Soft-delete: could not rename db user: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    // Rename Keycloak realm by disabling it and recording the new name
    try {
      await this.keycloak.disableRealm(project.keycloakRealm);
    } catch (err) {
      this.logger.warn(`Soft-delete: failed to disable Keycloak realm for "${project.name}": ${err}`);
    }

    await this.prisma.project.update({
      where: { id },
      data: {
        status: 'DELETED',
        name: deletedName,
        slug: deletedSlug,
        dbName: archivedDbName,
        dbUser: archivedDbUser,
        keycloakRealm: archivedRealm,
      },
    });

    this.usageService.decrementProjectCount(project.teamId).catch(() => {});

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    this.logger.log(`Project "${project.name}" soft-deleted by user ${userId} (db: ${archivedDbName})`);

    await this.activity.append(id, {
      userId,
      kind: ProjectActivityKind.PROJECT_DELETED,
      title: 'Project moved to trash',
      detail: project.name,
      metadata: {
        originalProjectName: project.name,
        reasonCode: reason?.reasonCode || 'none',
        reasonLabel: reason?.reasonLabel || 'None of the above',
        details: reason?.details?.trim() || null,
      },
    });

    return { message: 'Project deleted' };
  }

  async listDeletionReasons(userId: string, limit = 200) {
    const actor = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (actor?.role !== 'ROOT') {
      throw new ForbiddenException('Only ROOT can view project deletion reasons');
    }

    const rows = await this.prisma.projectActivityLog.findMany({
      where: { kind: ProjectActivityKind.PROJECT_DELETED },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(limit || 200, 500)),
    });

    const actorIds = Array.from(
      new Set(rows.map((x) => x.userId).filter((value): value is string => Boolean(value))),
    );
    const projectIds = Array.from(new Set(rows.map((x) => x.projectId)));

    const [actors, projects] = await Promise.all([
      actorIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          })
        : Promise.resolve([]),
      projectIds.length > 0
        ? this.prisma.project.findMany({
            where: { id: { in: projectIds } },
            select: {
              id: true,
              name: true,
              teamId: true,
              team: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const actorById = new Map(actors.map((a) => [a.id, a] as const));
    const projectById = new Map(projects.map((p) => [p.id, p] as const));

    return rows.map((x) => {
      const metadata =
        x.metadata && typeof x.metadata === 'object'
          ? (x.metadata as Record<string, unknown>)
          : {};
      return {
        id: x.id,
        createdAt: x.createdAt,
        actorUserId: x.userId,
        actorName: (() => {
          if (!x.userId) return null;
          const actorUser = actorById.get(x.userId);
          if (!actorUser) return null;
          return (
            [actorUser.firstName, actorUser.lastName].filter(Boolean).join(' ').trim() ||
            actorUser.email ||
            null
          );
        })(),
        projectId: x.projectId,
        projectName: (() => {
          const project = projectById.get(x.projectId);
          return (
            (typeof metadata.originalProjectName === 'string' &&
              metadata.originalProjectName) ||
            project?.name ||
            null
          );
        })(),
        teamId: projectById.get(x.projectId)?.team?.id || projectById.get(x.projectId)?.teamId || null,
        teamName: projectById.get(x.projectId)?.team?.name || null,
        reasonCode:
          typeof metadata.reasonCode === 'string' ? metadata.reasonCode : null,
        reasonLabel:
          typeof metadata.reasonLabel === 'string' ? metadata.reasonLabel : null,
        details: typeof metadata.details === 'string' ? metadata.details : null,
      };
    });
  }

  async findDeleted(teamId: string, userId: string) {
    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!membership || membership.role !== 'OWNER') {
      throw new ForbiddenException('Only the team owner can view deleted projects');
    }

    return this.prisma.project.findMany({
      where: { teamId, status: 'DELETED' },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async restore(id: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.status !== 'DELETED') {
      throw new ForbiddenException('Project is not deleted');
    }

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership || membership.role !== 'OWNER') {
      throw new ForbiddenException('Only the team owner can restore projects');
    }

    const originalName = this.stripDeletedSuffix(project.name);
    const originalSlug = this.stripDeletedSuffix(project.slug);

    const conflict = await this.prisma.project.findFirst({
      where: {
        OR: [{ name: originalName }, { slug: originalSlug }],
        id: { not: project.id },
        status: { not: 'DELETED' },
      },
      select: { id: true, name: true },
    });

    if (conflict) {
      throw new ForbiddenException(
        `A project named "${originalName}" already exists. Please delete or rename the existing project before restoring this one.`,
      );
    }

    // Derive the original DB name / user / realm from the archived names
    // e.g. "kb_usgourmet_del1234567890" → "kb_usgourmet"
    const originalDbName = project.dbName.replace(/_del\d+$/, '');
    const originalDbUser = project.dbUser.replace(/_del\d+$/, '');
    const originalRealm  = project.keycloakRealm.replace(/_del\d+$/, '');

    // Restore database and user names
    await this.renameDatabase(project.dbName, originalDbName);

    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      const sanitizedCurrent = project.dbUser.replace(/[^a-z0-9_]/g, '');
      const sanitizedOriginal = originalDbUser.replace(/[^a-z0-9_]/g, '');
      if (sanitizedCurrent !== sanitizedOriginal) {
        await client.query(`ALTER USER "${sanitizedCurrent}" RENAME TO "${sanitizedOriginal}"`);
      }
    } catch (err: any) {
      this.logger.warn(`Restore: could not rename db user back: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    // Re-enable (and rename back) Keycloak realm
    // Since Keycloak doesn't support direct rename, we enable the disabled realm
    // under its archived name. The keycloakRealm field in DB is updated to match.
    try {
      await this.keycloak.enableRealm(project.keycloakRealm);
    } catch (err) {
      this.logger.warn(`Restore: could not re-enable Keycloak realm: ${err}`);
    }

    await this.prisma.project.update({
      where: { id },
      data: {
        status: 'ACTIVE',
        name: originalName,
        slug: originalSlug,
        dbName: originalDbName,
        dbUser: originalDbUser,
        keycloakRealm: project.keycloakRealm, // keep the archived realm name; it's re-enabled above
      },
    });

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    this.logger.log(`Project "${originalName}" restored by user ${userId}`);

    await this.activity.append(id, {
      userId,
      kind: ProjectActivityKind.PROJECT_RESTORED,
      title: 'Project restored from trash',
      detail: originalName,
    });

    return { message: 'Project restored' };
  }

  async permanentDelete(id: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.status !== 'DELETED') {
      throw new ForbiddenException('Only deleted projects can be permanently removed');
    }

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership || membership.role !== 'OWNER') {
      throw new ForbiddenException('Only the team owner can permanently delete projects');
    }

    // Keycloak realm and database are already cleaned up during soft delete.
    // Attempt cleanup again just in case (e.g. old trash items from before this change).
    try {
      await this.keycloak.deleteRealm(project.keycloakRealm);
    } catch {
      // already deleted or never existed — safe to ignore
    }
    await this.dropDatabase(project.dbName).catch(() => {});
    await this.dropDatabaseUser(project.dbUser).catch(() => {});

    await this.prisma.project.delete({ where: { id } });

    this.logger.log(`Project "${project.name}" permanently deleted by user ${userId}`);

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    return { message: 'Project permanently deleted' };
  }

  async forceDelete(id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) return;

    try {
      await this.keycloak.deleteRealm(project.keycloakRealm);
    } catch (err) {
      this.logger.warn(`Failed to delete Keycloak realm: ${err}`);
    }

    await this.dropDatabase(project.dbName).catch(() => {});
    await this.dropDatabaseUser(project.dbUser).catch(() => {});

    await this.prisma.project.delete({ where: { id } });

    this.logger.log(`Project "${project.name}" force-deleted (cancelled import)`);

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredDeletedProjects() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const expired = await this.prisma.project.findMany({
      where: {
        status: 'DELETED',
        updatedAt: { lt: cutoff },
      },
    });

    if (expired.length === 0) {
      this.logger.log('Trash cleanup: no expired projects to remove');
      return;
    }

    this.logger.log(`Trash cleanup: permanently deleting ${expired.length} project(s) older than 24h`);

    for (const project of expired) {
      try {
        try {
          await this.keycloak.deleteRealm(project.keycloakRealm);
        } catch (err) {
          this.logger.warn(`Cleanup: failed to delete Keycloak realm for "${project.name}": ${err}`);
        }

        await this.dropDatabase(project.dbName).catch(() => {});
        await this.dropDatabaseUser(project.dbUser).catch(() => {});

        await this.prisma.project.delete({ where: { id: project.id } });

        this.logger.log(`Cleanup: permanently deleted "${project.name}"`);
      } catch (err: any) {
        this.logger.error(`Cleanup: failed to delete project "${project.name}": ${err.message}`);
      }
    }

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed after cleanup: ${err}`),
    );
  }

  private async assertTeamMember(teamId: string, userId: string) {
    if (!teamId) throw new ForbiddenException('No team specified');
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
  }

  private assertStrongDbPassword(password: string) {
    if (password.length < 12) {
      throw new BadRequestException('Password must be at least 12 characters');
    }
    if (!/[a-z]/.test(password)) {
      throw new BadRequestException('Password must include a lowercase letter');
    }
    if (!/[A-Z]/.test(password)) {
      throw new BadRequestException('Password must include an uppercase letter');
    }
    if (!/[0-9]/.test(password)) {
      throw new BadRequestException('Password must include a number');
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      throw new BadRequestException('Password must include a special character');
    }
    if (/\s/.test(password)) {
      throw new BadRequestException('Password must not contain spaces');
    }
  }

  private async renameDatabase(oldName: string, newName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitizedOld = oldName.replace(/[^a-z0-9_]/g, '');
    const sanitizedNew = newName.replace(/[^a-z0-9_]/g, '');
    try {
      // Terminate all active connections to the DB before renaming
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [sanitizedOld],
      );
      await client.query(`ALTER DATABASE "${sanitizedOld}" RENAME TO "${sanitizedNew}"`);
      this.logger.log(`Database renamed: "${sanitizedOld}" → "${sanitizedNew}"`);
    } catch (err: any) {
      this.logger.warn(`Failed to rename database "${sanitizedOld}" to "${sanitizedNew}": ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabase(dbName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      const sanitized = dbName.replace(/[^a-z0-9_]/g, '');
      await client.query(`CREATE DATABASE "${sanitized}"`);
      await client.query(`REVOKE CONNECT ON DATABASE "${sanitized}" FROM PUBLIC`);
      this.logger.log(`Database "${sanitized}" created (public connect revoked)`);
    } catch (err: any) {
      if (err.code === '42P04') {
        this.logger.warn(`Database "${dbName}" already exists`);
        return;
      }
      throw new InternalServerErrorException('Failed to create database');
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabaseUser(username: string, password: string, dbName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitizedUser = username.replace(/[^a-z0-9_]/g, '');
    const sanitizedDb = dbName.replace(/[^a-z0-9_]/g, '');

    try {
      await client.query(`CREATE USER "${sanitizedUser}" WITH PASSWORD '${password.replace(/'/g, "''")}'`);
      await client.query(`GRANT CONNECT ON DATABASE "${sanitizedDb}" TO "${sanitizedUser}"`);
      this.logger.log(`User "${sanitizedUser}" created`);
    } catch (err: any) {
      if (err.code === '42710') {
        this.logger.warn(`User "${sanitizedUser}" already exists`);
        return;
      }
      throw new InternalServerErrorException(`Failed to create database user: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    const projectPool = new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: sanitizedDb,
    });
    const projectClient = await projectPool.connect();
    try {
      await projectClient.query(`GRANT ALL PRIVILEGES ON SCHEMA public TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO "${sanitizedUser}"`);
    } finally {
      projectClient.release();
      await projectPool.end();
    }
  }

  private async dropDatabaseUser(username: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    const sanitized = username.replace(/[^a-z0-9_]/g, '');
    try {
      await client.query(`DROP USER IF EXISTS "${sanitized}"`);
      this.logger.log(`User "${sanitized}" dropped`);
    } catch (err: any) {
      this.logger.warn(`Failed to drop user "${sanitized}": ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async dropDatabase(dbName: string) {
    const pool = this.getAdminPool();
    const client = await pool.connect();
    try {
      const sanitized = dbName.replace(/[^a-z0-9_]/g, '');
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${sanitized}'`,
      );
      await client.query(`DROP DATABASE IF EXISTS "${sanitized}"`);
      this.logger.log(`Database "${sanitized}" dropped`);
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabaseOnHost(
    dbName: string,
    host: string,
    port: number,
    adminUser: string,
    adminPassword: string,
  ) {
    const pool = new Pool({ host, port, user: adminUser, password: adminPassword, database: 'postgres' });
    const client = await pool.connect();
    try {
      const sanitized = dbName.replace(/[^a-z0-9_]/g, '');
      await client.query(`CREATE DATABASE "${sanitized}"`);
      this.logger.log(`Database "${sanitized}" created on ${host}`);
    } catch (err: any) {
      if (err.code === '42P04') {
        this.logger.warn(`Database "${dbName}" already exists on ${host}`);
        return;
      }
      throw new InternalServerErrorException('Failed to create database');
    } finally {
      client.release();
      await pool.end();
    }
  }

  private async createDatabaseUserOnHost(
    username: string,
    password: string,
    dbName: string,
    host: string,
    port: number,
    adminUser: string,
    adminPassword: string,
  ) {
    const pool = new Pool({ host, port, user: adminUser, password: adminPassword, database: 'postgres' });
    const client = await pool.connect();
    const sanitizedUser = username.replace(/[^a-z0-9_]/g, '');
    const sanitizedDb = dbName.replace(/[^a-z0-9_]/g, '');
    try {
      await client.query(`CREATE USER "${sanitizedUser}" WITH PASSWORD '${password.replace(/'/g, "''")}'`);
      await client.query(`GRANT CONNECT ON DATABASE "${sanitizedDb}" TO "${sanitizedUser}"`);
      this.logger.log(`User "${sanitizedUser}" created on ${host}`);
    } catch (err: any) {
      if (err.code === '42710') {
        this.logger.warn(`User "${sanitizedUser}" already exists on ${host}`);
        return;
      }
      throw new InternalServerErrorException(`Failed to create database user: ${err.message}`);
    } finally {
      client.release();
      await pool.end();
    }

    const projectPool = new Pool({ host, port, user: adminUser, password: adminPassword, database: sanitizedDb });
    const projectClient = await projectPool.connect();
    try {
      await projectClient.query(`GRANT ALL PRIVILEGES ON SCHEMA public TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${sanitizedUser}"`);
      await projectClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO "${sanitizedUser}"`);
    } finally {
      projectClient.release();
      await projectPool.end();
    }
  }

  private getAdminPool(): Pool {
    return new Pool({
      host: this.config.get('database.host'),
      port: this.config.get('database.port'),
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: 'postgres',
    });
  }

  private toSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
  }

  private async uniqueSlug(base: string): Promise<string> {
    const existing = await this.prisma.project.findFirst({
      where: { slug: base },
      select: { id: true },
    });
    if (!existing) return base;

    for (let i = 2; i <= 100; i++) {
      const candidate = `${base}_${i}`;
      const found = await this.prisma.project.findFirst({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!found) return candidate;
    }
    return `${base}_${Date.now()}`;
  }

  private stripDeletedSuffix(value: string): string {
    return value.replace(/_(\d+_)?deleted$/, '');
  }

  private async uniqueDeletedName(baseName: string): Promise<string> {
    const candidate = `${baseName}_deleted`;
    const existing = await this.prisma.project.findFirst({
      where: { name: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;

    for (let i = 2; i <= 100; i++) {
      const numbered = `${baseName}_${i}_deleted`;
      const found = await this.prisma.project.findFirst({
        where: { name: numbered },
        select: { id: true },
      });
      if (!found) return numbered;
    }
    return `${baseName}_${Date.now()}_deleted`;
  }

  private async uniqueDeletedSlug(baseSlug: string): Promise<string> {
    const candidate = `${baseSlug}_deleted`;
    const existing = await this.prisma.project.findFirst({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;

    for (let i = 2; i <= 100; i++) {
      const numbered = `${baseSlug}_${i}_deleted`;
      const found = await this.prisma.project.findFirst({
        where: { slug: numbered },
        select: { id: true },
      });
      if (!found) return numbered;
    }
    return `${baseSlug}_${Date.now()}_deleted`;
  }
}
