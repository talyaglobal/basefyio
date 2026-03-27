import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { PgBouncerService } from '../pgbouncer/pgbouncer.service';
import { CreateProjectDto } from './dto/create-project.dto';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
    private readonly config: ConfigService,
    private readonly pgbouncer: PgBouncerService,
  ) {}

  async create(dto: CreateProjectDto & { teamId: string }, userId: string) {
    await this.assertTeamMember(dto.teamId, userId);

    const slug = await this.uniqueSlug(this.toSlug(dto.name));
    const dbName = `kb_${slug}`;
    const dbUser = `kb_user_${slug}`;
    const dbPassword = randomBytes(24).toString('base64url');
    const realmName = `kb-${slug}`;
    const dbHost = this.config.get<string>('database.host')!;
    const dbPort = this.config.get<number>('database.port')!;

    await this.createDatabase(dbName);
    await this.createDatabaseUser(dbUser, dbPassword, dbName);

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
        name: dto.name,
        slug,
        description: dto.description,
        dbName,
        dbHost,
        dbPort,
        dbUser,
        dbPassword,
        keycloakRealm: realmName,
        anonKey,
        serviceKey,
        teamId: dto.teamId,
      },
    });

    this.logger.log(`Project "${project.name}" created (${project.id})`);

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    return project;
  }

  async findAll(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);

    return this.prisma.project.findMany({
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
        createdAt: true,
        updatedAt: true,
      },
    });
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

    return { message: 'Project moved successfully' };
  }

  async remove(id: string, userId: string) {
    const project = await this.findOne(id, userId);

    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!membership || membership.role !== 'OWNER') {
      throw new ForbiddenException('Only the team owner can delete projects');
    }

    try {
      await this.keycloak.deleteRealm(project.keycloakRealm);
    } catch (err) {
      this.logger.warn(`Failed to delete Keycloak realm: ${err}`);
    }

    await this.dropDatabase(project.dbName);
    await this.dropDatabaseUser(project.dbUser);

    const deletedName = await this.uniqueDeletedName(project.name);
    const deletedSlug = await this.uniqueDeletedSlug(project.slug);

    await this.prisma.project.update({
      where: { id },
      data: { status: 'DELETED', name: deletedName, slug: deletedSlug },
    });

    this.logger.log(`Project "${project.name}" deleted (renamed to "${deletedName}")`);

    this.pgbouncer.regenerateConfig().catch((err) =>
      this.logger.warn(`PgBouncer config update failed: ${err}`),
    );

    return { message: 'Project deleted' };
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

  private async assertTeamMember(teamId: string, userId: string) {
    if (!teamId) throw new ForbiddenException('No team specified');
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
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
