/**
 * Database management — Supabase-style Indexes / Triggers / Functions /
 * Extensions for a project database, plus the metadata the RPC endpoint
 * needs. DDL runs as the project's own DB user (owner of its objects);
 * extensions install via the platform admin connection because
 * CREATE EXTENSION needs superuser, gated by an explicit allowlist.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Safe, commonly-useful extensions (mirrors Supabase's curated list). */
export const ALLOWED_EXTENSIONS = new Set([
  'uuid-ossp', 'pgcrypto', 'pg_trgm', 'citext', 'hstore', 'unaccent',
  'fuzzystrmatch', 'btree_gin', 'btree_gist', 'intarray', 'ltree',
  'tablefunc', 'cube', 'earthdistance', 'vector',
]);

@Injectable()
export class ProjectDatabaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private ident(name: string, what: string): string {
    if (!IDENT_RE.test(name)) throw new BadRequestException(`Invalid ${what} name`);
    return `"${name}"`;
  }

  private async withProjectDb<T>(
    projectId: string,
    userId: string | undefined,
    fn: (client: import('pg').PoolClient) => Promise<T>,
    asAdmin = false,
  ): Promise<T> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (userId) {
      const m = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!m) throw new NotFoundException('Project not found');
    }
    const pool = new Pool({
      host: project.dbHost,
      port: project.dbPort,
      user: asAdmin ? this.config.get<string>('database.user') : project.dbUser,
      password: asAdmin
        ? this.config.get<string>('database.password')
        : project.dbPassword,
      database: project.dbName,
      statement_timeout: 30_000,
    });
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
      await pool.end();
    }
  }

  // ── Indexes ──────────────────────────────────────────────

  async listIndexes(projectId: string, userId?: string) {
    return this.withProjectDb(projectId, userId, async (c) => {
      const r = await c.query(`
        SELECT i.indexname AS name, i.tablename AS table, i.indexdef AS definition,
               idx.indisunique AS "isUnique", idx.indisprimary AS "isPrimary",
               pg_size_pretty(pg_relation_size(quote_ident(i.indexname)::regclass)) AS size
        FROM pg_indexes i
        JOIN pg_class cls ON cls.relname = i.indexname
        JOIN pg_index idx ON idx.indexrelid = cls.oid
        WHERE i.schemaname = 'public'
        ORDER BY i.tablename, i.indexname`);
      return r.rows;
    });
  }

  async createIndex(
    projectId: string,
    userId: string | undefined,
    body: { table: string; columns: string[]; unique?: boolean; method?: string; name?: string },
  ) {
    const table = this.ident(body.table, 'table');
    if (!body.columns?.length) throw new BadRequestException('At least one column required');
    const cols = body.columns.map((col) => this.ident(col, 'column')).join(', ');
    const method = (body.method || 'btree').toLowerCase();
    if (!['btree', 'hash', 'gin', 'gist', 'brin'].includes(method)) {
      throw new BadRequestException('Invalid index method');
    }
    const name = body.name?.trim()
      ? this.ident(body.name.trim(), 'index')
      : this.ident(`idx_${body.table}_${body.columns.join('_')}`.slice(0, 60), 'index');
    const unique = body.unique ? 'UNIQUE ' : '';
    return this.withProjectDb(projectId, userId, async (c) => {
      await c.query(`CREATE ${unique}INDEX ${name} ON ${table} USING ${method} (${cols})`);
      return { message: 'Index created' };
    });
  }

  async dropIndex(projectId: string, userId: string | undefined, name: string) {
    const ident = this.ident(name, 'index');
    return this.withProjectDb(projectId, userId, async (c) => {
      await c.query(`DROP INDEX ${ident}`);
      return { message: 'Index dropped' };
    });
  }

  // ── Triggers ─────────────────────────────────────────────

  async listTriggers(projectId: string, userId?: string) {
    return this.withProjectDb(projectId, userId, async (c) => {
      const r = await c.query(`
        SELECT t.tgname AS name, cls.relname AS table,
               pg_get_triggerdef(t.oid) AS definition, t.tgenabled != 'D' AS enabled
        FROM pg_trigger t
        JOIN pg_class cls ON cls.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = cls.relnamespace
        WHERE n.nspname = 'public' AND NOT t.tgisinternal
        ORDER BY cls.relname, t.tgname`);
      return r.rows;
    });
  }

  async createTrigger(
    projectId: string,
    userId: string | undefined,
    body: {
      name: string; table: string; timing: 'BEFORE' | 'AFTER';
      events: ('INSERT' | 'UPDATE' | 'DELETE')[]; functionName: string;
      forEach?: 'ROW' | 'STATEMENT';
    },
  ) {
    const name = this.ident(body.name, 'trigger');
    const table = this.ident(body.table, 'table');
    const fn = this.ident(body.functionName, 'function');
    if (!['BEFORE', 'AFTER'].includes(body.timing)) throw new BadRequestException('Invalid timing');
    const events = (body.events || []).filter((e) => ['INSERT', 'UPDATE', 'DELETE'].includes(e));
    if (!events.length) throw new BadRequestException('At least one event required');
    const forEach = body.forEach === 'STATEMENT' ? 'STATEMENT' : 'ROW';
    return this.withProjectDb(projectId, userId, async (c) => {
      await c.query(
        `CREATE TRIGGER ${name} ${body.timing} ${events.join(' OR ')} ON ${table} FOR EACH ${forEach} EXECUTE FUNCTION ${fn}()`,
      );
      return { message: 'Trigger created' };
    });
  }

  async toggleTrigger(
    projectId: string, userId: string | undefined,
    body: { name: string; table: string; enabled: boolean },
  ) {
    const name = this.ident(body.name, 'trigger');
    const table = this.ident(body.table, 'table');
    return this.withProjectDb(projectId, userId, async (c) => {
      await c.query(`ALTER TABLE ${table} ${body.enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${name}`);
      return { message: `Trigger ${body.enabled ? 'enabled' : 'disabled'}` };
    });
  }

  async dropTrigger(
    projectId: string, userId: string | undefined,
    body: { name: string; table: string },
  ) {
    const name = this.ident(body.name, 'trigger');
    const table = this.ident(body.table, 'table');
    return this.withProjectDb(projectId, userId, async (c) => {
      await c.query(`DROP TRIGGER ${name} ON ${table}`);
      return { message: 'Trigger dropped' };
    });
  }

  // ── Functions ────────────────────────────────────────────

  async listFunctions(projectId: string, userId?: string) {
    return this.withProjectDb(projectId, userId, async (c) => {
      const r = await c.query(`
        SELECT p.proname AS name,
               pg_get_function_identity_arguments(p.oid) AS args,
               pg_get_function_result(p.oid) AS returns,
               l.lanname AS language,
               pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
        WHERE n.nspname = 'public' AND p.prokind = 'f'
          AND l.lanname IN ('sql', 'plpgsql')
        ORDER BY p.proname`);
      return r.rows;
    });
  }

  /** Raw CREATE [OR REPLACE] FUNCTION DDL, validated to be exactly that. */
  async createFunction(projectId: string, userId: string | undefined, sql: string) {
    const trimmed = (sql || '').trim();
    if (!/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s/i.test(trimmed)) {
      throw new BadRequestException('Body must be a single CREATE [OR REPLACE] FUNCTION statement');
    }
    return this.withProjectDb(projectId, userId, async (c) => {
      await c.query(trimmed);
      return { message: 'Function created' };
    });
  }

  async dropFunction(projectId: string, userId: string | undefined, name: string, args?: string) {
    const ident = this.ident(name, 'function');
    // args comes from pg_get_function_identity_arguments — already canonical.
    const safeArgs = (args || '').replace(/[;'"\\]/g, '');
    return this.withProjectDb(projectId, userId, async (c) => {
      await c.query(`DROP FUNCTION ${ident}(${safeArgs})`);
      return { message: 'Function dropped' };
    });
  }

  // ── Extensions ───────────────────────────────────────────

  async listExtensions(projectId: string, userId?: string) {
    return this.withProjectDb(projectId, userId, async (c) => {
      const r = await c.query(`
        SELECT name, default_version AS "defaultVersion", installed_version AS "installedVersion", comment
        FROM pg_available_extensions ORDER BY name`);
      return r.rows
        .filter((row) => ALLOWED_EXTENSIONS.has(row.name))
        .map((row) => ({ ...row, enabled: row.installedVersion !== null }));
    });
  }

  async setExtension(
    projectId: string, userId: string | undefined,
    body: { name: string; enabled: boolean },
  ) {
    if (!ALLOWED_EXTENSIONS.has(body.name)) {
      throw new BadRequestException('Extension is not in the allowed list');
    }
    const ident = `"${body.name}"`;
    // CREATE EXTENSION needs superuser → run via the platform admin connection.
    return this.withProjectDb(
      projectId,
      userId,
      async (c) => {
        if (body.enabled) {
          await c.query(`CREATE EXTENSION IF NOT EXISTS ${ident}`);
        } else {
          await c.query(`DROP EXTENSION IF EXISTS ${ident}`);
        }
        return { message: `Extension ${body.enabled ? 'enabled' : 'disabled'}` };
      },
      true,
    );
  }
}
