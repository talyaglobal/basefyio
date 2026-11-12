import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Client, QueryResult } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { findForbiddenSqlPattern } from '../sql/sql-guard';
import {
  AnalyzedStatement,
  VerificationTarget,
  quoteQualified,
  verificationTargets,
} from './ai-sql';
import type { ProjectSchemaSnapshot, SchemaTable } from './ai-prompt';

/** Rows of a result kept for the panel and the model; the rest is counted, not copied. */
const MAX_RESULT_ROWS = 100;
const MAX_SCHEMA_TABLES = 200;
const SCHEMA_CACHE_MS = 30_000;

type ProjectRow = {
  id: string;
  name: string;
  teamId: string;
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
};

export interface StatementResult {
  sql: string;
  ok: boolean;
  /** Postgres command tag: SELECT, INSERT, CREATE TABLE … */
  command: string;
  /** Rows affected (writes) or returned (reads), as Postgres reports it. */
  rowCount: number | null;
  fields: string[];
  rows: Record<string, unknown>[];
  /** True when more rows existed than were kept. */
  truncated: boolean;
  error?: string;
  durationMs: number;
}

export interface VerificationResult {
  label: string;
  passed: boolean;
}

export interface DryRunResult {
  /** passed: every statement ran inside a rolled-back transaction; failed: one did not. */
  status: 'passed' | 'failed' | 'partial';
  failedIndex: number | null;
  error: string | null;
  /** Statements that could not be checked this way, with the reason. */
  notes: string[];
}

export interface ApplyResult {
  /** Every statement committed. */
  ok: boolean;
  /** All-or-nothing: false only when a statement cannot run inside a transaction. */
  atomic: boolean;
  statements: (StatementResult & { verification: VerificationResult[] })[];
  /** Index of the statement that failed, when one did. */
  failedIndex: number | null;
}

/** Postgres error codes a dry run treats as "could not check", not as "invalid". */
const NOT_CHECKABLE = new Set([
  '25001', // active_sql_transaction: cannot run inside a transaction block
  '55P03', // lock_not_available: the table is busy
  '57014', // query_canceled: statement timeout
]);

/** Statements Postgres refuses inside a transaction block. */
function needsAutocommit(sql: string): boolean {
  return /\bCONCURRENTLY\b/i.test(sql) || /^\s*(VACUUM|CREATE\s+DATABASE|ALTER\s+SYSTEM)\b/i.test(sql);
}

/**
 * The assistant's own door into a project database.
 *
 * Separate from the SQL editor's path on purpose: the assistant needs
 * statement-by-statement results, a READ ONLY transaction for what it runs on
 * its own, a rolled-back dry run for what it proposes, and a catalog re-read
 * after an approved change. The access rules are the editor's: an active
 * project, a team member, and the same forbidden-statement guard.
 */
@Injectable()
export class AiDatabaseService {
  private readonly logger = new Logger(AiDatabaseService.name);
  private readonly schemaCache = new Map<string, { at: number; snapshot: ProjectSchemaSnapshot }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** The project, if it is active and the caller is on its team; NotFound otherwise. */
  async resolveProject(projectId: string, userId: string): Promise<ProjectRow> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        teamId: true,
        dbHost: true,
        dbPort: true,
        dbUser: true,
        dbPassword: true,
        dbName: true,
      },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
      select: { userId: true },
    });
    if (!member) throw new NotFoundException('Project not found');
    return project as ProjectRow;
  }

  private async withClient<T>(project: ProjectRow, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({
      host: project.dbHost,
      port: project.dbPort,
      user: project.dbUser,
      password: project.dbPassword,
      database: project.dbName,
      statement_timeout: 60_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'basefyio-ai-assistant',
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private guard(sql: string) {
    const pattern = findForbiddenSqlPattern(sql, 'owner');
    if (pattern) throw new BadRequestException(`Forbidden SQL operation: ${pattern}`);
  }

  /* ───────────────────────────── schema ───────────────────────────── */

  /**
   * Tables, columns, keys, RLS state, policies and the auth helpers, read from
   * the live database. Cached for a few seconds so one agent turn does not read
   * it twice; an applied change clears the cache.
   */
  async readSchema(project: ProjectRow): Promise<ProjectSchemaSnapshot> {
    const cached = this.schemaCache.get(project.id);
    if (cached && Date.now() - cached.at < SCHEMA_CACHE_MS) return cached.snapshot;

    const snapshot = await this.withClient(project, async (client) => {
      await client.query('BEGIN READ ONLY');
      try {
        await client.query(`SET LOCAL statement_timeout = '10s'`);
        const tables = await client.query(
          `SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls,
                  GREATEST(c.reltuples, -1)::bigint AS est
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'auth')
              AND n.nspname NOT LIKE 'pg\\_%'
              AND NOT (n.nspname = 'public' AND c.relname IN ('kb_embeddings', 'kb_embeddings_store'))
            ORDER BY (n.nspname = 'public') DESC, n.nspname, c.relname
            LIMIT ${MAX_SCHEMA_TABLES + 1}`,
        );
        const truncated = tables.rows.length > MAX_SCHEMA_TABLES;
        const rows = tables.rows.slice(0, MAX_SCHEMA_TABLES);
        const oids = rows.map((r) => r.oid);

        const [columns, constraints, policies, authFns, version] = oids.length
          ? await Promise.all([
              client.query(
                `SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                        NOT a.attnotnull AS nullable, pg_get_expr(d.adbin, d.adrelid) AS dflt
                   FROM pg_attribute a
                   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped
                  ORDER BY a.attrelid, a.attnum`,
                [oids],
              ),
              client.query(
                `SELECT con.conrelid AS oid, con.contype AS type,
                        ARRAY(SELECT a.attname FROM unnest(con.conkey) k
                                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS cols,
                        CASE WHEN con.contype = 'f' THEN
                          con.confrelid::regclass::text || '(' || array_to_string(ARRAY(
                            SELECT a.attname FROM unnest(con.confkey) k
                              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k), ', ') || ')'
                        END AS refs
                   FROM pg_constraint con
                  WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p', 'f')`,
                [oids],
              ),
              client.query(
                `SELECT polrelid AS oid, polname AS name,
                        CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE'
                                    WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS command
                   FROM pg_policy WHERE polrelid = ANY($1::oid[]) ORDER BY polname`,
                [oids],
              ),
              this.authFunctions(client),
              client.query(`SELECT current_setting('server_version') AS v`),
            ])
          : await Promise.all([
              Promise.resolve({ rows: [] } as unknown as QueryResult),
              Promise.resolve({ rows: [] } as unknown as QueryResult),
              Promise.resolve({ rows: [] } as unknown as QueryResult),
              this.authFunctions(client),
              client.query(`SELECT current_setting('server_version') AS v`),
            ]);

        const byOid = new Map<number, SchemaTable>();
        const list: SchemaTable[] = rows.map((r) => {
          const t: SchemaTable = {
            schema: r.schema,
            name: r.name,
            columns: [],
            primaryKey: [],
            foreignKeys: [],
            rlsEnabled: r.rls === true,
            policies: [],
            estimatedRows: Number(r.est) >= 0 ? Number(r.est) : null,
          };
          byOid.set(Number(r.oid), t);
          return t;
        });
        for (const c of columns.rows) {
          byOid.get(Number(c.oid))?.columns.push({
            name: c.name,
            type: c.type,
            nullable: c.nullable === true,
            default: c.dflt ?? null,
          });
        }
        for (const k of constraints.rows) {
          const t = byOid.get(Number(k.oid));
          if (!t) continue;
          if (k.type === 'p') t.primaryKey = k.cols;
          else t.foreignKeys.push({ columns: k.cols, references: k.refs });
        }
        for (const p of policies.rows) {
          byOid.get(Number(p.oid))?.policies.push({ name: p.name, command: p.command });
        }
        return {
          tables: list,
          authFunctions: authFns,
          truncated,
          postgresVersion: String(version.rows[0]?.v ?? '').split(' ')[0] || null,
        } as ProjectSchemaSnapshot;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    });

    this.schemaCache.set(project.id, { at: Date.now(), snapshot });
    return snapshot;
  }

  private async authFunctions(client: Client): Promise<{ name: string; returns: string }[]> {
    const res = await client.query(
      `SELECT 'auth.' || p.proname AS name, format_type(p.prorettype, NULL) AS returns
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname IN ('uid', 'jwt', 'role', 'email') AND p.pronargs = 0
        ORDER BY array_position(ARRAY['uid', 'jwt', 'role', 'email']::name[], p.proname)`,
    );
    return res.rows.map((r) => ({ name: r.name, returns: r.returns }));
  }

  /* ───────────────────────────── read-only run ───────────────────────────── */

  /**
   * Run statements the classifier judged read-only, inside a READ ONLY
   * transaction that is always rolled back. A statement that would write after
   * all (a function with side effects, say) fails here instead of writing.
   * The snapshot is taken before the first statement, so a statement cannot
   * switch the transaction back to read-write.
   */
  async runReadOnly(project: ProjectRow, userId: string, statements: string[]): Promise<StatementResult[]> {
    for (const s of statements) this.guard(s);
    const results: StatementResult[] = [];
    await this.withClient(project, async (client) => {
      await client.query('BEGIN READ ONLY');
      try {
        await client.query(`SET LOCAL statement_timeout = '20s'`);
        await client.query('SELECT 1');
        for (const sql of statements) {
          const t0 = Date.now();
          try {
            const res = await client.query(sql);
            results.push(toResult(sql, res as QueryResult, Date.now() - t0));
          } catch (err: any) {
            results.push(failure(sql, err, Date.now() - t0));
            break;
          }
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    });
    await this.audit(project.id, userId, results, false);
    return results;
  }

  /* ───────────────────────────── dry run ───────────────────────────── */

  /**
   * Check a proposed change against the real schema without keeping it.
   *
   * Row changes (INSERT/UPDATE/DELETE/MERGE) are only PREPAREd — parsed and
   * analysed against the tables, never executed, so no trigger fires and no
   * row is touched. Schema changes are executed inside a transaction that is
   * always rolled back, with short lock and statement timeouts so a busy table
   * is skipped rather than waited on. Later statements see earlier ones, so a
   * CREATE TABLE followed by an INSERT into it checks correctly.
   */
  async dryRun(project: ProjectRow, statements: AnalyzedStatement[]): Promise<DryRunResult> {
    for (const s of statements) this.guard(s.sql);
    const notes: string[] = [];
    return this.withClient(project, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '2s'`);
        await client.query(`SET LOCAL statement_timeout = '5s'`);
        for (let i = 0; i < statements.length; i++) {
          const s = statements[i];
          if (needsAutocommit(s.sql) || s.kind === 'other' || s.command === 'CALL') {
            notes.push(`Statement ${i + 1} (${s.command}) cannot be checked in advance.`);
            continue;
          }
          const isRowChange = ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(s.command) ||
            (s.kind === 'write' && /^\s*WITH\b/i.test(s.sql));
          await client.query('SAVEPOINT bf_ai_check');
          try {
            if (isRowChange) {
              await client.query(`PREPARE bf_ai_check AS ${s.sql}`);
              await client.query('DEALLOCATE bf_ai_check');
            } else {
              await client.query(s.sql);
            }
            await client.query('RELEASE SAVEPOINT bf_ai_check');
          } catch (err: any) {
            await client.query('ROLLBACK TO SAVEPOINT bf_ai_check');
            if (NOT_CHECKABLE.has(err?.code)) {
              notes.push(
                err.code === '25001'
                  ? `Statement ${i + 1} (${s.command}) must run outside a transaction and could not be checked in advance.`
                  : `Statement ${i + 1} (${s.command}) could not be checked: the table is busy (${err.message}).`,
              );
              continue;
            }
            return {
              status: 'failed' as const,
              failedIndex: i,
              error: formatPgError(err),
              notes,
            };
          }
        }
        return {
          status: notes.length ? ('partial' as const) : ('passed' as const),
          failedIndex: null,
          error: null,
          notes,
        };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
      }
    });
  }

  /* ───────────────────────────── apply ───────────────────────────── */

  /**
   * Run an approved change and check the catalog afterwards.
   *
   * The script runs in one transaction: either every statement commits or
   * none does, and the result says which statement failed. Only statements
   * Postgres refuses inside a transaction (CREATE INDEX CONCURRENTLY …) force
   * a statement-by-statement run, which the result reports as not atomic.
   */
  async apply(project: ProjectRow, userId: string, statements: AnalyzedStatement[]): Promise<ApplyResult> {
    for (const s of statements) this.guard(s.sql);
    const atomic = !statements.some((s) => needsAutocommit(s.sql));
    const results: StatementResult[] = [];
    let failedIndex: number | null = null;

    const outcome = await this.withClient(project, async (client) => {
      if (atomic) await client.query('BEGIN');
      try {
        for (let i = 0; i < statements.length; i++) {
          const sql = statements[i].sql;
          const t0 = Date.now();
          try {
            const res = await client.query(sql);
            results.push(toResult(sql, res as QueryResult, Date.now() - t0));
          } catch (err: any) {
            results.push(failure(sql, err, Date.now() - t0));
            failedIndex = i;
            break;
          }
        }
        if (atomic) {
          if (failedIndex === null) await client.query('COMMIT');
          else await client.query('ROLLBACK');
        }
      } catch (err) {
        if (atomic) await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }

      // What the database holds now — checked for every statement that ran,
      // and for none of them when an atomic script was rolled back.
      const verified: (StatementResult & { verification: VerificationResult[] })[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const committed = r.ok && (failedIndex === null || !atomic);
        const verification = committed ? await this.verify(client, verificationTargets(r.sql)) : [];
        verified.push({ ...r, verification });
      }
      return verified;
    });

    this.schemaCache.delete(project.id);
    await this.audit(project.id, userId, results, true);
    const ok = failedIndex === null && outcome.every((s) => s.verification.every((v) => v.passed));
    return { ok, atomic, statements: outcome, failedIndex };
  }

  private async verify(client: Client, targets: VerificationTarget[]): Promise<VerificationResult[]> {
    const out: VerificationResult[] = [];
    for (const t of targets) {
      try {
        out.push(await this.verifyOne(client, t));
      } catch (err: any) {
        out.push({ label: `Could not check the result: ${err?.message ?? err}`, passed: false });
      }
    }
    return out;
  }

  private async verifyOne(client: Client, t: VerificationTarget): Promise<VerificationResult> {
    const exists = async (sql: string, params: unknown[]) => (await client.query(sql, params)).rows.length > 0;
    switch (t.type) {
      case 'relation_exists':
      case 'relation_absent': {
        const name = quoteQualified(t.relation);
        const found = await exists(`SELECT 1 WHERE to_regclass($1) IS NOT NULL`, [name]);
        const want = t.type === 'relation_exists';
        return {
          passed: found === want,
          label: want
            ? found
              ? `The ${t.label} ${display(t.relation)} exists.`
              : `The ${t.label} ${display(t.relation)} was not found after the change.`
            : found
              ? `${display(t.relation)} still exists.`
              : `${display(t.relation)} no longer exists.`,
        };
      }
      case 'rls_enabled': {
        const res = await client.query(`SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass($1)`, [
          quoteQualified(t.relation),
        ]);
        if (!res.rows.length) return { passed: false, label: `Table ${display(t.relation)} was not found.` };
        const on = res.rows[0].relrowsecurity === true;
        return {
          passed: on === t.enabled,
          label: on
            ? `Row level security is ON for ${display(t.relation)}.`
            : `Row level security is OFF for ${display(t.relation)}.`,
        };
      }
      case 'policy_exists':
      case 'policy_absent': {
        const found = await exists(`SELECT 1 FROM pg_policy WHERE polname = $1 AND polrelid = to_regclass($2)`, [
          t.policy,
          quoteQualified(t.relation),
        ]);
        const want = t.type === 'policy_exists';
        return {
          passed: found === want,
          label: found
            ? `Policy "${t.policy}" exists on ${display(t.relation)}.`
            : `Policy "${t.policy}" does not exist on ${display(t.relation)}.`,
        };
      }
      case 'column_exists':
      case 'column_absent': {
        const found = await exists(
          `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND attnum > 0 AND NOT attisdropped`,
          [quoteQualified(t.relation), t.column],
        );
        const want = t.type === 'column_exists';
        return {
          passed: found === want,
          label: found
            ? `Column ${t.column} exists on ${display(t.relation)}.`
            : `Column ${t.column} does not exist on ${display(t.relation)}.`,
        };
      }
      case 'function_exists': {
        const found = await exists(
          `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = $1 AND (CASE WHEN $2::text IS NULL THEN n.nspname = ANY(current_schemas(false)) ELSE n.nspname = $2 END)`,
          [t.fn.name, t.fn.schema],
        );
        return {
          passed: found,
          label: found ? `Function ${display(t.fn)} exists.` : `Function ${display(t.fn)} was not found.`,
        };
      }
    }
  }

  /** Every statement the assistant ran is in the SQL audit log, attributed to the person. */
  private async audit(projectId: string, userId: string, results: StatementResult[], isChange: boolean) {
    try {
      if (results.length) {
        await this.prisma.sqlAuditLog.createMany({
          data: results.map((r) => ({
            projectId,
            userId,
            query: `/* basefyio AI assistant${isChange ? ', approved change' : ', read-only'} */ ${r.sql}`,
            rowCount: r.ok ? r.rowCount : null,
            duration: r.durationMs,
            ...(r.ok ? {} : { error: r.error ?? 'failed' }),
          })),
        });
      }
      if (isChange) {
        const failed = results.find((r) => !r.ok);
        await this.activity.append(projectId, {
          userId,
          kind: failed ? ProjectActivityKind.SQL_FAILED : ProjectActivityKind.SQL_EXECUTED,
          title: failed
            ? 'AI assistant change failed and was rolled back'
            : `AI assistant change applied (${results.length} statement${results.length === 1 ? '' : 's'})`,
          detail: results
            .map((r) => `${r.ok ? '✓' : '✗'} ${r.sql.replace(/\s+/g, ' ').slice(0, 200)}${r.ok ? '' : ` — ${r.error}`}`)
            .join('\n')
            .slice(0, 4000),
        });
      }
    } catch (err: any) {
      this.logger.warn(`Could not write the AI audit trail for ${projectId}: ${err?.message ?? err}`);
    }
  }
}

function display(q: { schema: string | null; name: string }): string {
  return q.schema ? `${q.schema}.${q.name}` : q.name;
}

function toResult(sql: string, res: QueryResult, durationMs: number): StatementResult {
  const rows = Array.isArray(res.rows) ? res.rows : [];
  return {
    sql,
    ok: true,
    command: res.command ?? '',
    rowCount: typeof res.rowCount === 'number' ? res.rowCount : null,
    fields: res.fields?.map((f) => f.name) ?? [],
    rows: rows.slice(0, MAX_RESULT_ROWS),
    truncated: rows.length > MAX_RESULT_ROWS,
    durationMs,
  };
}

function failure(sql: string, err: any, durationMs: number): StatementResult {
  return {
    sql,
    ok: false,
    command: '',
    rowCount: null,
    fields: [],
    rows: [],
    truncated: false,
    error: formatPgError(err),
    durationMs,
  };
}

/** Postgres' message plus its hint/detail, which usually say how to fix it. */
export function formatPgError(err: any): string {
  const parts = [String(err?.message ?? err)];
  if (err?.detail) parts.push(`Detail: ${err.detail}`);
  if (err?.hint) parts.push(`Hint: ${err.hint}`);
  return parts.join(' ').slice(0, 1000);
}
