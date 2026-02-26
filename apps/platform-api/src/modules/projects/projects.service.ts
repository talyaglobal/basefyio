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
import { CreateProjectDto } from './dto/create-project.dto';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
    private readonly config: ConfigService,
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
    return project;
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

    await this.prisma.project.update({
      where: { id },
      data: { status: 'DELETED' },
    });

    this.logger.log(`Project "${project.name}" deleted`);
    return { message: 'Project deleted' };
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
}
