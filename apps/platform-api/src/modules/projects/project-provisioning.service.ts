import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';

/** Where and as whom to run administrative SQL against a project database. */
export interface AdminTarget {
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * The extensions `sql/default-extensions.sql` installs. Kept in sync with the
 * file by the spec; used to report which of them ended up present.
 */
export const DEFAULT_EXTENSIONS = [
  'pg_trgm',
  'pgcrypto',
  'unaccent',
  'btree_gist',
  'uuid-ossp',
  'vector',
  'pg_stat_statements',
] as const;

export interface DefaultExtensionsResult {
  /** Extensions from DEFAULT_EXTENSIONS present in the database afterwards. */
  installed: string[];
  /** Statements that failed, with the server's reason. Never fatal. */
  skipped: { statement: string; error: string }[];
  /** Set when the database could not be reached at all. */
  error?: string;
}

const IDENT_RE = /^[a-z0-9_]{1,63}$/;

/**
 * Split the extension file into runnable statements: one per line, comments
 * and blank lines dropped, one trailing semicolon removed. A `DO $$ … $$`
 * block written on a single line stays one statement.
 */
export function parseStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--'))
    .map((line) => line.replace(/;\s*$/, ''));
}

/**
 * Installs the default extension set into a project database.
 *
 * Runs as the cluster admin because CREATE EXTENSION needs it. Every statement
 * runs on its own and a failure is recorded rather than thrown: a project is
 * worth more than an extension, so provisioning never fails here.
 */
@Injectable()
export class ProjectProvisioningService {
  private readonly logger = new Logger(ProjectProvisioningService.name);
  private sqlCache: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** PROVISION_DEFAULT_EXTENSIONS=false turns the provisioning-time install off. */
  isEnabled(): boolean {
    return this.config.get<boolean>('provisioning.defaultExtensions') !== false;
  }

  private loadSql(): string {
    if (this.sqlCache) return this.sqlCache;
    // Next to the compiled service after `nest build` (copied by nest-cli
    // assets), next to the source under ts-node and jest.
    this.sqlCache = readFileSync(join(__dirname, 'sql', 'default-extensions.sql'), 'utf8');
    return this.sqlCache;
  }

  /** The statements that would run, for tests and for showing what "defaults" means. */
  statements(): string[] {
    return parseStatements(this.loadSql());
  }

  async installDefaultExtensions(
    target: AdminTarget & { dbName: string },
    opts?: { force?: boolean },
  ): Promise<DefaultExtensionsResult> {
    const result: DefaultExtensionsResult = { installed: [], skipped: [] };
    if (!opts?.force && !this.isEnabled()) return result;
    if (!IDENT_RE.test(target.dbName)) {
      result.error = 'Invalid database identifier';
      return result;
    }

    const statements = this.statements();
    const pool = new Pool({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: target.dbName,
      max: 1,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    try {
      const client = await pool.connect();
      try {
        for (const statement of statements) {
          try {
            await client.query(statement);
          } catch (err: any) {
            result.skipped.push({ statement, error: err?.message || String(err) });
          }
        }
        const { rows } = await client.query<{ extname: string }>(
          'SELECT extname FROM pg_extension',
        );
        const present = new Set(rows.map((r) => r.extname));
        result.installed = DEFAULT_EXTENSIONS.filter((name) => present.has(name));
      } finally {
        client.release();
      }
    } catch (err: any) {
      result.error = err?.message || String(err);
      this.logger.error(
        `Default extensions for "${target.dbName}" could not be installed: ${result.error}`,
      );
    } finally {
      await pool.end().catch(() => undefined);
    }

    if (result.skipped.length) {
      this.logger.warn(
        `Default extensions for "${target.dbName}": ${result.skipped.length} statement(s) skipped — ` +
          result.skipped.map((s) => s.error).join('; '),
      );
    }
    this.logger.log(
      `Default extensions for "${target.dbName}": ${result.installed.join(', ') || 'none'}`,
    );
    return result;
  }

  /**
   * Opt-in install for an existing project (Database page). The caller must be
   * a member of the project's team.
   */
  async installDefaultExtensionsForProject(
    projectId: string,
    userId?: string,
  ): Promise<DefaultExtensionsResult> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: {
        id: true,
        teamId: true,
        dbName: true,
        dbHost: true,
        dbPort: true,
        infrastructure: { select: { pgAdminUser: true, pgAdminPassword: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (userId) {
      const member = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!member) throw new NotFoundException('Project not found');
    }
    const target = this.resolveAdminTarget(project);
    return this.installDefaultExtensions({ ...target, dbName: project.dbName }, { force: true });
  }

  /**
   * Admin credentials for a project's database: the platform's own on the
   * shared cluster, the container's on a dedicated host (recorded at
   * provisioning). A dedicated host without a record cannot be administered
   * from here, and says so.
   */
  resolveAdminTarget(project: {
    dbHost: string;
    dbPort: number;
    infrastructure?: { pgAdminUser: string | null; pgAdminPassword: string | null } | null;
  }): AdminTarget {
    const cfgHost = this.config.get<string>('database.host') || 'localhost';
    const cfgPort = Number(this.config.get<number>('database.port') ?? 5432);
    if (project.dbHost === cfgHost && Number(project.dbPort) === cfgPort) {
      return {
        host: cfgHost,
        port: cfgPort,
        user: this.config.get<string>('database.user') || 'postgres',
        password: this.config.get<string>('database.password') || '',
      };
    }
    const infra = project.infrastructure;
    if (infra?.pgAdminUser && infra?.pgAdminPassword) {
      return {
        host: project.dbHost,
        port: Number(project.dbPort),
        user: infra.pgAdminUser,
        password: infra.pgAdminPassword,
      };
    }
    throw new InternalServerErrorException(
      'This project runs on a dedicated database host without stored admin credentials; run this step through the provisioning flow',
    );
  }
}
