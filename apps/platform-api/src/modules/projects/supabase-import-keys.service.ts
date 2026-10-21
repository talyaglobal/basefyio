import { BadRequestException, Injectable, Logger } from '@nestjs/common';

/**
 * Anything that runs SQL: a pg Pool or a checked-out client. Kept structural so
 * the unit tests can hand in a plain object.
 */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** PostgREST marks a key column in its schema description with this tag. */
const PK_TAG_RE = /<pk\s*\/>/i;
const PK_NOTE_RE = /\bThis is a Primary Key\b/i;

export type PrimaryKeyRepairStatus =
  /** The table already has a primary key; nothing to do. */
  | 'present'
  /** A key was added. */
  | 'added'
  /** Dry run: the key would be added, here is the statement. */
  | 'would_add'
  /** The source does not describe a key for this table. */
  | 'no_source_key'
  /** A key column from the source does not exist here. */
  | 'column_missing'
  /** The rows here are not unique on the key, or hold nulls in it. */
  | 'not_unique'
  /** The statement was refused; see `error`. */
  | 'failed'
  /** The time budget ran out before this table; run again. */
  | 'pending';

export interface PrimaryKeyRepairResult {
  table: string;
  columns: string[];
  status: PrimaryKeyRepairStatus;
  duplicateGroups?: number;
  nullRows?: number;
  sql?: string;
  error?: string;
}

export interface PrimaryKeyRepairSummary {
  dryRun: boolean;
  examined: number;
  added: number;
  wouldAdd: number;
  skipped: number;
  failed: number;
  pending: number;
  results: PrimaryKeyRepairResult[];
}

export interface PrimaryKeyRepairOptions {
  /** Report what would be done, run no DDL. */
  dryRun?: boolean;
  /** Only these tables; every other table is left alone. */
  tables?: string[];
  /** Stop starting new tables after this long; the rest come back `pending`. */
  budgetMs?: number;
  /** Called after each table; progress reporting for long runs. */
  onTable?: (result: PrimaryKeyRepairResult) => void | Promise<void>;
  /** Clock, replaceable in tests. */
  now?: () => number;
}

/**
 * Primary keys for imported tables.
 *
 * A table that arrived without its key cannot be synced: there is no way to
 * tell a row that is new at the source from one that is already here. The key
 * is known — the source database has it, and the API's schema description
 * names it — so it can be put back, provided the rows here really are unique
 * on it. This service reads the key from either side and adds it where the
 * data allows, reporting plainly where it does not.
 */
@Injectable()
export class SupabaseImportKeysService {
  private readonly logger = new Logger(SupabaseImportKeysService.name);

  /** Whether a PostgREST column description marks the column as part of the key. */
  isPrimaryKeyNote(description: unknown): boolean {
    const text = typeof description === 'string' ? description : '';
    return PK_TAG_RE.test(text) || PK_NOTE_RE.test(text);
  }

  /**
   * Key columns per table, from the PostgREST schema description.
   *
   * Column order follows the description, which lists columns in table order.
   */
  keysFromOpenApi(openApi: any): Map<string, string[]> {
    const keys = new Map<string, string[]>();
    const definitions = openApi?.definitions;
    if (!definitions || typeof definitions !== 'object') return keys;

    for (const [table, definition] of Object.entries<any>(definitions)) {
      const properties = definition?.properties;
      if (!properties || typeof properties !== 'object') continue;
      const columns: string[] = [];
      for (const [column, spec] of Object.entries<any>(properties)) {
        if (this.isPrimaryKeyNote(spec?.description)) columns.push(column);
      }
      if (columns.length) keys.set(table, columns);
    }
    return keys;
  }

  /** Key columns per public table, from a database's own catalogue. */
  async keysFromSourceCatalog(source: SqlRunner): Promise<Map<string, string[]>> {
    const { rows } = await source.query(
      `select c.relname as "table", array_agg(a.attname order by k.ord) as columns
         from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where i.indisprimary and n.nspname = 'public' and c.relkind in ('r', 'p')
        group by c.relname`,
    );
    const keys = new Map<string, string[]>();
    for (const row of rows) {
      const columns = Array.isArray(row.columns) ? row.columns.map(String) : [];
      if (row.table && columns.length) keys.set(String(row.table), columns);
    }
    return keys;
  }

  /** Public base tables that have a primary key. */
  async listKeyedTables(db: SqlRunner): Promise<Set<string>> {
    const { rows } = await db.query(
      `select c.relname as name
         from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
        where i.indisprimary and n.nspname = 'public' and c.relkind in ('r', 'p')`,
    );
    return new Set(rows.map((r: any) => String(r.name)));
  }

  /** Public base tables without a primary key, alphabetically. */
  async listMissingPrimaryKeys(db: SqlRunner): Promise<string[]> {
    const { rows } = await db.query(
      `select t.table_name as name
         from information_schema.tables t
        where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
          and not exists (
            select 1
              from pg_index i
              join pg_class c on c.oid = i.indrelid
              join pg_namespace n on n.oid = c.relnamespace
             where i.indisprimary and n.nspname = 'public' and c.relname = t.table_name)
        order by t.table_name`,
    );
    return rows.map((r: any) => String(r.name));
  }

  /**
   * Add the source's primary key to every table here that lacks one.
   *
   * Each table is its own transaction with a short lock timeout, so a busy
   * table is reported and skipped rather than queued behind live traffic, and
   * one refusal never stops the next table. A key is only ever added where the
   * rows are unique and non-null on it; anything else is reported with the
   * numbers, because forcing it would mean deleting data.
   */
  async repairPrimaryKeys(
    db: SqlRunner,
    sourceKeys: Map<string, string[]>,
    options: PrimaryKeyRepairOptions = {},
  ): Promise<PrimaryKeyRepairSummary> {
    const now = options.now ?? (() => Date.now());
    const budgetMs = options.budgetMs ?? 60_000;
    const started = now();
    const dryRun = !!options.dryRun;

    if (options.tables) {
      for (const table of options.tables) {
        if (!IDENT_RE.test(table)) {
          throw new BadRequestException(`Invalid table name: ${table}`);
        }
      }
    }

    const missing = new Set(await this.listMissingPrimaryKeys(db));
    const targets = options.tables?.length ? options.tables : [...missing];

    const results: PrimaryKeyRepairResult[] = [];
    const report = async (result: PrimaryKeyRepairResult) => {
      results.push(result);
      if (options.onTable) await options.onTable(result);
    };

    for (const table of targets) {
      const columns = sourceKeys.get(table) ?? [];

      if (!missing.has(table)) {
        await report({ table, columns, status: 'present' });
        continue;
      }
      if (now() - started > budgetMs) {
        await report({ table, columns, status: 'pending', error: 'time budget exhausted; run again to continue' });
        continue;
      }
      if (!IDENT_RE.test(table)) {
        await report({ table, columns, status: 'failed', error: 'unsupported table name' });
        continue;
      }
      if (columns.length === 0) {
        await report({ table, columns, status: 'no_source_key' });
        continue;
      }
      if (columns.some((c) => !IDENT_RE.test(c))) {
        await report({ table, columns, status: 'failed', error: 'unsupported column name in the key' });
        continue;
      }

      const ident = `"public"."${table}"`;
      const quoted = columns.map((c) => `"${c}"`);

      try {
        const { rows: present } = await db.query(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1`,
          [table],
        );
        const have = new Set(present.map((r: any) => String(r.column_name)));
        const absent = columns.filter((c) => !have.has(c));
        if (absent.length) {
          await report({ table, columns, status: 'column_missing', error: `missing here: ${absent.join(', ')}` });
          continue;
        }

        const { rows: dupes } = await db.query(
          `select count(*)::int as groups
             from (select 1 from ${ident} group by ${quoted.join(', ')} having count(*) > 1) d`,
        );
        const { rows: nulls } = await db.query(
          `select count(*)::int as nulls from ${ident}
            where ${quoted.map((q) => `${q} is null`).join(' or ')}`,
        );
        const duplicateGroups = Number(dupes[0]?.groups ?? 0);
        const nullRows = Number(nulls[0]?.nulls ?? 0);
        if (duplicateGroups > 0 || nullRows > 0) {
          await report({ table, columns, status: 'not_unique', duplicateGroups, nullRows });
          continue;
        }

        const sql = `ALTER TABLE ${ident} ADD PRIMARY KEY (${quoted.join(', ')})`;
        if (dryRun) {
          await report({ table, columns, status: 'would_add', sql });
          continue;
        }

        try {
          await db.query('BEGIN');
          await db.query(`SET LOCAL lock_timeout = '5s'`);
          await db.query(`SET LOCAL statement_timeout = '120s'`);
          await db.query(sql);
          await db.query('COMMIT');
        } catch (err: any) {
          await db.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
        this.logger.log(`Added primary key (${columns.join(', ')}) to "${table}"`);
        await report({ table, columns, status: 'added', sql });
      } catch (err: any) {
        await report({ table, columns, status: 'failed', error: this.explain(err) });
      }
    }

    const count = (status: PrimaryKeyRepairStatus) => results.filter((r) => r.status === status).length;
    return {
      dryRun,
      examined: results.length,
      added: count('added'),
      wouldAdd: count('would_add'),
      skipped: count('present') + count('no_source_key') + count('column_missing') + count('not_unique'),
      failed: count('failed'),
      pending: count('pending'),
      results,
    };
  }

  /** One line a person can act on, for a result that did not add a key. */
  describe(result: PrimaryKeyRepairResult): string {
    switch (result.status) {
      case 'not_unique': {
        const parts: string[] = [];
        if (result.duplicateGroups) parts.push(`${result.duplicateGroups} duplicate value group(s)`);
        if (result.nullRows) parts.push(`${result.nullRows} row(s) with a null key column`);
        return `rows are not unique on (${result.columns.join(', ')}): ${parts.join(', ')}`;
      }
      case 'no_source_key':
        return 'the source does not describe a primary key for this table';
      case 'column_missing':
        return result.error ?? 'a key column is missing here';
      case 'failed':
        return result.error ?? 'the statement was refused';
      case 'pending':
        return 'ran out of time; run again to continue';
      default:
        return '';
    }
  }

  private explain(err: any): string {
    const code = err?.code;
    if (code === '55P03') return 'table is busy (another session holds a lock); run again';
    if (code === '57014') return 'timed out building the index; run again';
    return String(err?.message ?? err);
  }
}
