import type { BasefyioFetchClient } from '../lib/fetch.js';
import { BasefyioClientError, toBasefyioError, toJson } from '../lib/errors.js';
import type {
  BasefyioError,
  BasefyioResponse,
  SqlResult,
  TableInfo,
  ColumnInfo,
  Filter,
  FilterOperator,
  OrFilter,
  OrderClause,
} from '../lib/types.js';

// ── SQL value escaping ──────────────────────────────────

function escapeValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) throw new Error('Non-finite numbers are not supported');
    return String(val);
  }
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (Array.isArray(val)) return `(${val.map(escapeValue).join(', ')})`;
  const str = String(val).replace(/'/g, "''");
  return `'${str}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * How one value reaches the database: written into the statement, or bound.
 *
 * Both modes run through the same builder, so the SQL `toSQL()` shows is the
 * SQL `execute()` sends apart from the values. `execute()` binds, and that is
 * not only the safer half:
 *
 * The API scans every statement for forbidden operations and reads string
 * literals too, because a literal is where a smuggled `COPY` would hide. An
 * ordinary value written into SQL is therefore refused as the operation it
 * happens to name — "page load", "grant access", a message that says "copy".
 * A bound value is never part of the statement, so it is never scanned as one.
 *
 * `toSQL()` keeps inlining, because what it is for is being read.
 */
type Binder = (value: unknown) => string;

/** Values written into the statement — the shape `toSQL()` has always had. */
const inlineBinder: Binder = escapeValue;

/** Values kept out of the statement; `$1 … $n` go in their place. */
function paramBinder(params: unknown[]): Binder {
  return (value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('Non-finite numbers are not supported');
    }
    // `undefined` reaches the database as NULL either way; the driver would
    // otherwise send nothing at all for the placeholder.
    params.push(value === undefined ? null : value);
    return `$${params.length}`;
  };
}

/** A LIMIT or OFFSET count: never a bound value, so never anything but a number. */
function countLiteral(value: number, what: string): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer`);
  }
  return String(value);
}

// ── Or Condition Builder ───────────────────────────────

export class OrConditionBuilder {
  private _filters: OrFilter[] = [];

  /** @internal */
  getFilters(): OrFilter[] {
    return this._filters;
  }

  eq(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'eq', value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'neq', value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'gt', value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'gte', value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'lt', value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'lte', value });
    return this;
  }

  like(column: string, pattern: string): this {
    this._filters.push({ column, operator: 'like', value: pattern });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this._filters.push({ column, operator: 'ilike', value: pattern });
    return this;
  }

  is(column: string, value: null | boolean): this {
    this._filters.push({ column, operator: 'is', value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this._filters.push({ column, operator: 'in', value: values });
    return this;
  }

  not(column: string, operator: FilterOperator, value: unknown): this {
    this._filters.push({ column, operator, value, negate: true });
    return this;
  }
}

// ── Select list ─────────────────────────────────────────

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A type name for a cast: words and an optional `[]`, never quotes or parentheses. */
const CAST_TYPE = /^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*(?:\[\])?$/;
const AGGREGATE = /^(count|sum|avg|min|max)\(\s*(\*|[A-Za-z_][A-Za-z0-9_]*)?\s*\)$/i;

interface SelectTerm {
  sql: string;
  aggregate: boolean;
}

/**
 * One entry of `select('…')` as SQL.
 *
 * Understood: a column, `col::type`, `count(*)` / `sum(col)` / `avg` / `min` /
 * `max`, and an alias written `col as label` or `label:col`. Anything else is
 * quoted whole as one column name, which is what every entry used to be — so a
 * column whose name holds a space or a capital still selects as it always did.
 */
function selectTerm(raw: string): SelectTerm {
  let expr = raw;
  let alias: string | undefined;

  const asMatch = raw.match(/^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
  const colonMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):(?!:)(.+)$/);
  if (asMatch) {
    expr = asMatch[1].trim();
    alias = asMatch[2];
  } else if (colonMatch) {
    alias = colonMatch[1];
    expr = colonMatch[2].trim();
  }

  let sql: string | undefined;
  let aggregate = false;
  const agg = expr.match(AGGREGATE);
  if (agg) {
    const fn = agg[1].toLowerCase();
    const arg = agg[2];
    if (fn === 'count' && (!arg || arg === '*')) sql = 'count(*)';
    else if (arg && arg !== '*') sql = `${fn}(${quoteIdent(arg)})`;
    aggregate = sql !== undefined;
  } else if (PLAIN_IDENT.test(expr)) {
    sql = quoteIdent(expr);
  } else {
    const cast = expr.indexOf('::');
    if (cast > 0) {
      const col = expr.slice(0, cast).trim();
      const type = expr.slice(cast + 2).trim();
      if (PLAIN_IDENT.test(col) && CAST_TYPE.test(type)) sql = `${quoteIdent(col)}::${type}`;
    }
  }

  if (sql === undefined) return { sql: quoteIdent(raw), aggregate: false };
  return { sql: alias ? `${sql} AS ${quoteIdent(alias)}` : sql, aggregate };
}

/**
 * The select list, and the GROUP BY an aggregate next to plain columns needs:
 * `select('status, count(*)')` counts per status.
 */
function selectList(columns: string): { list: string; groupBy: string } {
  const raw = columns.trim();
  if (raw === '' || raw === '*') return { list: '*', groupBy: '' };
  const entries = raw.split(',').map((c) => c.trim()).filter(Boolean);
  const terms = entries.map((entry) => (entry === '*' ? { sql: '*', aggregate: false } : selectTerm(entry)));
  const list = terms.map((t) => t.sql).join(', ');
  const plain = terms.filter((t) => !t.aggregate && t.sql !== '*');
  const groupBy =
    terms.some((t) => t.aggregate) && plain.length
      ? ` GROUP BY ${plain.map((t) => t.sql.replace(/ AS "[^"]*(?:""[^"]*)*"$/, '')).join(', ')}`
      : '';
  return { list, groupBy };
}

// ── Query Builder ───────────────────────────────────────

type Operation = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

/** `single()` asks for exactly one row; `maybeSingle()` for at most one. */
type SingleMode = 'single' | 'maybe' | null;

/** Options for a write that would otherwise be refused without a filter. */
export interface FullTableOptions {
  /**
   * Run an `update()` or `delete()` that has no filter, changing every row of
   * the table. Without it such a call is refused: it is almost always a
   * forgotten `.eq(…)`, and it cannot be taken back.
   */
  allowFullTable?: boolean;
}

export interface UpsertOptions {
  /** The unique column(s) a duplicate is detected on. Default: the primary key. */
  onConflict?: string | string[];
  /** Keep the existing row instead of updating it. */
  ignoreDuplicates?: boolean;
}

/**
 * Raised inside the database by a `single()` / `maybeSingle()` write that
 * would touch more than one row. The statement fails, so nothing is changed;
 * the SDK turns the message into a readable error.
 */
const SINGLE_GUARD_MARKER = 'single() refused:';

/** PostgREST's code for "a single row was requested, and zero or several matched". */
const SINGLE_ROW_CODE = 'PGRST116';

function unionKeys(rows: Record<string, unknown>[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

export class QueryBuilder<T = Record<string, unknown>, R = T[]> implements PromiseLike<BasefyioResponse<R>> {
  private http: BasefyioFetchClient;
  private projectId: string;
  private _table: string;
  private _op: Operation = 'select';
  private _selectCols = '*';
  /** Columns a write returns, from `.select()` after `insert()`/`update()`/… */
  private _returning: string | null = null;
  private _insertRows: Record<string, unknown>[] = [];
  private _updateData: Record<string, unknown> = {};
  private _upsertConflict: string[] = [];
  private _upsertIgnore = false;
  private _allowFullTable = false;
  private _filters: Filter[] = [];
  private _or: OrFilter[][] = [];
  private _orRaw: string[] = [];
  private _orders: OrderClause[] = [];
  private _limit?: number;
  private _offset?: number;
  private _single: SingleMode = null;
  private _count: 'exact' | null = null;

  constructor(http: BasefyioFetchClient, projectId: string, table: string) {
    this.http = http;
    this.projectId = projectId;
    this._table = table;
  }

  // ── Operations ───────────────────────────────────────

  /**
   * Choose the columns to read — or, after `insert()`, `update()`, `upsert()`
   * or `delete()`, the columns the written rows come back with. (It used to
   * turn the write into a read, so `insert(row).select()` silently inserted
   * nothing.)
   *
   * Accepts column names, `col::type`, `count(*)` and `sum/avg/min/max(col)`,
   * with an alias as `col as label` or `label:col`.
   */
  select(columns = '*'): this {
    if (this._op === 'select') {
      this._selectCols = columns;
    } else {
      this._returning = columns;
    }
    return this;
  }

  insert(data: Partial<T> | Partial<T>[]): this {
    this._op = 'insert';
    this._insertRows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
    return this;
  }

  /**
   * Update the rows the filters match.
   *
   * Without a filter this is refused — it would update every row. Pass
   * `{ allowFullTable: true }` when that is the intent.
   */
  update(data: Partial<T>, options?: FullTableOptions): this {
    this._op = 'update';
    this._updateData = data as Record<string, unknown>;
    this._allowFullTable = options?.allowFullTable === true;
    return this;
  }

  /**
   * Delete the rows the filters match.
   *
   * Without a filter this is refused — it would empty the table. Pass
   * `{ allowFullTable: true }` when that is the intent.
   */
  delete(options?: FullTableOptions): this {
    this._op = 'delete';
    this._allowFullTable = options?.allowFullTable === true;
    return this;
  }

  /**
   * Insert, or update the row that already has the same key.
   *
   * The key is `onConflict` (a unique column or columns) or, by default, the
   * table's primary key. A row that carries only its key has nothing to
   * update and is left as it is; so is every duplicate with
   * `{ ignoreDuplicates: true }`. Runs through the REST endpoint, under the
   * same role and row-level policies as `insert()`.
   */
  upsert(data: Partial<T> | Partial<T>[], options?: UpsertOptions): this {
    this._op = 'upsert';
    this._insertRows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
    const conflict = options?.onConflict;
    this._upsertConflict = conflict
      ? (Array.isArray(conflict) ? conflict : conflict.split(',')).map((s) => s.trim()).filter(Boolean)
      : [];
    this._upsertIgnore = options?.ignoreDuplicates === true;
    return this;
  }

  // ── Filters ──────────────────────────────────────────

  eq(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'eq', value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'neq', value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'gt', value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'gte', value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'lt', value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this._filters.push({ column, operator: 'lte', value });
    return this;
  }

  like(column: string, pattern: string): this {
    this._filters.push({ column, operator: 'like', value: pattern });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this._filters.push({ column, operator: 'ilike', value: pattern });
    return this;
  }

  is(column: string, value: null | boolean): this {
    this._filters.push({ column, operator: 'is', value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this._filters.push({ column, operator: 'in', value: values });
    return this;
  }

  not(column: string, operator: FilterOperator, value: unknown): this {
    this._filters.push({ column, operator, value, negate: true });
    return this;
  }

  /**
   * Add an OR condition group using safe, structured filter objects.
   * Each call creates an OR group: the filters within the callback are
   * OR-ed together, and the resulting group is AND-ed with other clauses.
   *
   * @example
   * // WHERE ... AND ("status" = 'active' OR "role" = 'admin')
   * bf.from('users')
   *   .select()
   *   .or((q) => q.eq('status', 'active').eq('role', 'admin'))
   */
  or(buildFn: (q: OrConditionBuilder) => OrConditionBuilder): this {
    const builder = new OrConditionBuilder();
    buildFn(builder);
    const filters = builder.getFilters();
    if (filters.length) {
      this._or.push(filters);
    }
    return this;
  }

  /**
   * Add a raw OR condition string. The string is inserted into the WHERE
   * clause **without any escaping or sanitization**.
   *
   * **WARNING: NEVER pass unsanitized user input to this method. Doing so
   * creates a SQL injection vulnerability. Prefer the safe `or()` method
   * with structured filter objects instead.**
   *
   * @example
   * .orRaw("status = 'active' OR role = 'admin'")
   */
  orRaw(conditions: string): this {
    this._orRaw.push(conditions);
    return this;
  }

  // ── Modifiers ────────────────────────────────────────

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this._orders.push({
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst,
    });
    return this;
  }

  limit(count: number): this {
    this._limit = count;
    return this;
  }

  offset(count: number): this {
    this._offset = count;
    return this;
  }

  range(from: number, to: number): this {
    this._offset = from;
    this._limit = to - from + 1;
    return this;
  }

  /**
   * Resolve to one row instead of an array — and to an error unless exactly
   * one row matched (code `PGRST116`). On `update()` / `delete()` a filter
   * matching several rows is refused inside the database, so nothing is
   * changed. To take the first of several rows, add `.limit(1)`.
   */
  single(): QueryBuilder<T, T> {
    this._single = 'single';
    return this as unknown as QueryBuilder<T, T>;
  }

  /**
   * Like `single()`, but no row is not an error: `data` is null. Several rows
   * still are.
   */
  maybeSingle(): QueryBuilder<T, T> {
    this._single = 'maybe';
    return this as unknown as QueryBuilder<T, T>;
  }

  // ── SQL generation ───────────────────────────────────

  /**
   * One filter as SQL.
   *
   * Shared by the AND list and by every OR group. The two used to carry the
   * same switch twice, and with a binder a second copy is worse than untidy:
   * it is a second place for a value to end up written into the statement.
   */
  private filterClause(f: Filter | OrFilter, bind: Binder): string {
    const col = quoteIdent(f.column);
    const neg = f.negate ? 'NOT ' : '';
    let clause: string;

    switch (f.operator) {
      case 'eq':  clause = `${col} = ${bind(f.value)}`; break;
      case 'neq': clause = `${col} != ${bind(f.value)}`; break;
      case 'gt':  clause = `${col} > ${bind(f.value)}`; break;
      case 'gte': clause = `${col} >= ${bind(f.value)}`; break;
      case 'lt':  clause = `${col} < ${bind(f.value)}`; break;
      case 'lte': clause = `${col} <= ${bind(f.value)}`; break;
      case 'like':  clause = `${col} LIKE ${bind(f.value)}`; break;
      case 'ilike': clause = `${col} ILIKE ${bind(f.value)}`; break;
      // NULL and the booleans are syntax here, not values: `IS $1` is not SQL.
      case 'is':  clause = `${col} IS ${f.value === null ? 'NULL' : f.value ? 'TRUE' : 'FALSE'}`; break;
      case 'in':  clause = this.inClause(col, f.value, bind); break;
      case 'not': clause = `NOT (${col} = ${bind(f.value)})`; break;
      default:    clause = `${col} = ${bind(f.value)}`;
    }

    return neg ? `${neg}(${clause})` : clause;
  }

  /**
   * A test against a list.
   *
   * Bound, the list is one value and the test becomes `= ANY($n)`: the same
   * rows, one placeholder instead of one per element, and an honest answer for
   * the empty list — `IN ()` is a syntax error, `= ANY` of nothing is no rows.
   */
  private inClause(col: string, value: unknown, bind: Binder): string {
    if (bind === inlineBinder) return `${col} IN ${escapeValue(value)}`;
    return `${col} = ANY(${bind(Array.isArray(value) ? value : [value])})`;
  }

  /** The filters as one condition (no `WHERE`), or '' when there are none. */
  private buildConditions(bind: Binder): string {
    const parts: string[] = [];

    for (const f of this._filters) {
      parts.push(this.filterClause(f, bind));
    }

    for (const orGroup of this._or) {
      const orParts = orGroup.map((f) => this.filterClause(f, bind));
      parts.push(`(${orParts.join(' OR ')})`);
    }

    for (const raw of this._orRaw) {
      parts.push(`(${raw})`);
    }

    return parts.join(' AND ');
  }

  private buildWhereClause(bind: Binder): string {
    const conditions = this.buildConditions(bind);
    return conditions ? ` WHERE ${conditions}` : '';
  }

  /**
   * The WHERE clause of an UPDATE or DELETE.
   *
   * No filter means every row, and that is refused unless the caller said so
   * with `{ allowFullTable: true }`. Under `single()` / `maybeSingle()` the
   * clause also carries a guard that fails the statement when more than one
   * row matches: UPDATE and DELETE take no LIMIT, and the statement failing
   * is what guarantees nothing was changed.
   */
  private buildWriteWhere(verb: 'update' | 'delete', bind: Binder): string {
    const conditions = this.buildConditions(bind);
    if (!conditions && !this._allowFullTable) {
      throw new BasefyioClientError(
        `${verb}() without a filter would ${verb === 'update' ? 'change' : 'delete'} every row of "${this._table}". ` +
          `Add a filter such as .eq('id', value), or pass { allowFullTable: true } to ${verb} every row on purpose.`,
      );
    }
    if (!this._single) return conditions ? ` WHERE ${conditions}` : '';

    const scope = conditions ? ` WHERE ${conditions}` : '';
    const guard =
      `(SELECT CASE WHEN count(*) <= 1 THEN 1 ELSE ` +
      `('${SINGLE_GUARD_MARKER} ' || count(*) || ' rows matched')::int END ` +
      `FROM ${quoteIdent(this._table)}${scope}) = 1`;
    return conditions ? ` WHERE (${conditions}) AND ${guard}` : ` WHERE ${guard}`;
  }

  private buildOrderClause(): string {
    if (!this._orders.length) return '';
    const parts = this._orders.map((o) => {
      let s = `${quoteIdent(o.column)} ${o.ascending ? 'ASC' : 'DESC'}`;
      if (o.nullsFirst !== undefined) s += o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
      return s;
    });
    return ` ORDER BY ${parts.join(', ')}`;
  }

  private buildLimitOffset(): string {
    let s = '';
    // Counts, not values: these are written into the statement in both modes,
    // so they are checked rather than trusted — a caller reaching this from
    // plain JavaScript can pass anything at all.
    if (this._limit !== undefined) s += ` LIMIT ${countLiteral(this._limit, 'limit')}`;
    // single() reads two rows when no limit was set, so "more than one" can be
    // told apart from "exactly one".
    else if (this._single) s += ' LIMIT 2';
    if (this._offset !== undefined) s += ` OFFSET ${countLiteral(this._offset, 'offset')}`;
    return s;
  }

  private returningClause(): string {
    if (this._returning === null) return ' RETURNING *';
    return ` RETURNING ${selectList(this._returning).list}`;
  }

  /** The statement, with every value handed to `bind`. One builder, two modes. */
  private build(bind: Binder): string {
    const table = quoteIdent(this._table);

    switch (this._op) {
      case 'select': {
        const { list, groupBy } = selectList(this._selectCols);
        return `SELECT ${list} FROM ${table}${this.buildWhereClause(bind)}${groupBy}${this.buildOrderClause()}${this.buildLimitOffset()}`;
      }

      case 'insert': {
        if (!this._insertRows.length) throw new BasefyioClientError('No data to insert');
        const allKeys = unionKeys(this._insertRows);
        const cols = allKeys.map(quoteIdent).join(', ');
        const rows = this._insertRows.map((row) => {
          const vals = allKeys.map((k) => bind(row[k] ?? null));
          return `(${vals.join(', ')})`;
        });
        return `INSERT INTO ${table} (${cols}) VALUES ${rows.join(', ')}${this.returningClause()}`;
      }

      case 'update': {
        const sets = Object.entries(this._updateData)
          .map(([k, v]) => `${quoteIdent(k)} = ${bind(v)}`)
          .join(', ');
        if (!sets) throw new BasefyioClientError('No data to update');
        return `UPDATE ${table} SET ${sets}${this.buildWriteWhere('update', bind)}${this.returningClause()}`;
      }

      case 'delete': {
        return `DELETE FROM ${table}${this.buildWriteWhere('delete', bind)}${this.returningClause()}`;
      }

      case 'upsert': {
        if (!this._insertRows.length) throw new BasefyioClientError('No data to upsert');
        const allKeys = unionKeys(this._insertRows);
        const cols = allKeys.map(quoteIdent).join(', ');
        const rows = this._insertRows.map((row) => {
          const vals = allKeys.map((k) => bind(row[k] ?? null));
          return `(${vals.join(', ')})`;
        });
        // Without onConflict the key is the primary key; its constraint is
        // named "<table>_pkey" unless it was named otherwise. (Execution goes
        // through the REST endpoint, which looks the primary key up.)
        const target = this._upsertConflict.length
          ? `(${this._upsertConflict.map(quoteIdent).join(', ')})`
          : `ON CONSTRAINT ${quoteIdent(`${this._table}_pkey`)}`;
        const updateCols = allKeys
          .filter((k) => !this._upsertConflict.includes(k))
          .map((k) => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`)
          .join(', ');
        // Nothing but the key to write means nothing to update: DO NOTHING,
        // never the invalid `DO UPDATE SET` with an empty list.
        const action = this._upsertIgnore || !updateCols ? 'DO NOTHING' : `DO UPDATE SET ${updateCols}`;
        return `INSERT INTO ${table} (${cols}) VALUES ${rows.join(', ')} ON CONFLICT ${target} ${action}${this.returningClause()}`;
      }
    }
  }

  /**
   * The statement with its values written in — what a person reads.
   *
   * Kept as it was, and no longer what `execute()` sends. Inlined, an ordinary
   * value is refused by the API when it happens to name a forbidden operation
   * ("page load", "grant access"), because the guard reads string literals too.
   * `toQuery()` is what actually runs.
   *
   * For `upsert()` this is the equivalent statement; the upsert itself is sent
   * to the REST endpoint, which resolves the primary key on the server.
   */
  toSQL(): string {
    return this.build(inlineBinder);
  }

  /** The statement as it is sent: placeholders, and the values beside them. */
  toQuery(): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const text = this.build(paramBinder(params));
    return { text, params };
  }

  // ── Execution ────────────────────────────────────────

  private async execute(): Promise<BasefyioResponse<R>> {
    try {
      if ((this._op === 'insert' || this._op === 'upsert') && this._single && this._insertRows.length > 1) {
        return this.singleError(
          `${this._single === 'single' ? 'single' : 'maybeSingle'}() was given ${this._insertRows.length} rows to write; it returns one`,
        );
      }

      if (this._op === 'upsert' && this.upsertGoesToRest()) {
        return this.finish(await this.upsertViaRest());
      }

      const { text, params } = this.toQuery();
      const result = await this.http.json<SqlResult>('/sql/execute', {
        method: 'POST',
        // `params` rides along only when there are any, so a query carrying no
        // values sends byte-for-byte the request it always did — and still
        // works against an API that has never heard of parameters. `limit`
        // likewise: only a read asking for more than the API's default page
        // of 100 rows sends it, so `.limit(500)` returns 500 rows, not 100.
        body: toJson({
          projectId: this.projectId,
          query: text,
          ...(params.length ? { params } : {}),
          ...this.pageSize(),
        }),
      });

      return this.finish((result.rows ?? []) as T[]);
    } catch (err: unknown) {
      return { data: null, error: this.describeError(toBasefyioError(err)) };
    }
  }

  /** The API pages a SELECT at 100 rows unless told otherwise; tell it the caller's limit (at most 1000). */
  private pageSize(): { limit?: number } {
    if (this._op !== 'select' || this._limit === undefined || this._limit <= 100) return {};
    return { limit: Math.min(this._limit, 1000) };
  }

  /**
   * Upserts go to `POST /rest/v1/:table` with `Prefer: resolution=…`, which
   * finds the primary key itself and runs under the caller's role and
   * policies. A table or column name the REST endpoint cannot address (a
   * space, a dash) keeps the SQL path.
   */
  private upsertGoesToRest(): boolean {
    if (!PLAIN_IDENT.test(this._table)) return false;
    if (!unionKeys(this._insertRows).every((k) => PLAIN_IDENT.test(k))) return false;
    return this._upsertConflict.every((c) => PLAIN_IDENT.test(c));
  }

  private async upsertViaRest(): Promise<T[]> {
    if (!this._insertRows.length) throw new BasefyioClientError('No data to upsert');
    // Every row carries every column — missing ones as null — exactly as the
    // SQL form of the statement wrote them.
    const keys = unionKeys(this._insertRows);
    const rows = this._insertRows.map((row) =>
      Object.fromEntries(keys.map((k) => [k, row[k] === undefined ? null : row[k]])),
    );
    const query = new URLSearchParams();
    if (this._upsertConflict.length) query.set('on_conflict', this._upsertConflict.join(','));
    if (this._returning !== null && this._returning.trim() !== '' && this._returning.trim() !== '*') {
      query.set('select', this._returning.split(',').map((c) => c.trim()).filter(Boolean).join(','));
    }
    const qs = query.toString();
    const data = await this.http.json<T[]>(`/rest/v1/${encodeURIComponent(this._table)}${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      headers: {
        Prefer: `return=representation,resolution=${this._upsertIgnore ? 'ignore-duplicates' : 'merge-duplicates'}`,
      },
      body: toJson(rows),
    });
    return Array.isArray(data) ? data : [];
  }

  /** Shape the rows into the response, applying single() / maybeSingle(). */
  private finish(rows: T[]): BasefyioResponse<R> {
    if (!this._single) return { data: rows as unknown as R, error: null };
    const name = this._single === 'single' ? 'single' : 'maybeSingle';
    if (rows.length > 1) {
      return this.singleError(
        `${name}() expected one row, but more than one matched. Narrow the filter, or add .limit(1) to take the first`,
      );
    }
    if (rows.length === 0) {
      if (this._single === 'maybe') return { data: null, error: null };
      return this.singleError('single() expected one row, but none matched');
    }
    return { data: rows[0] as unknown as R, error: null };
  }

  private singleError(message: string): BasefyioResponse<R> {
    return { data: null, error: { message, code: SINGLE_ROW_CODE, status: 406 } };
  }

  /** Turn the single() write guard's database error into what it means. */
  private describeError(error: BasefyioError): BasefyioError {
    const m = error.message.match(/single\(\) refused: (\d+) rows matched/);
    if (!m) return error;
    const name = this._single === 'maybe' ? 'maybeSingle' : 'single';
    return {
      message: `${name}() refused this ${this._op}: the filter matched ${m[1]} rows, and nothing was changed. Narrow the filter to one row`,
      code: SINGLE_ROW_CODE,
      status: 406,
    };
  }

  then<TResult1 = BasefyioResponse<R>, TResult2 = never>(
    onfulfilled?: ((value: BasefyioResponse<R>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

// ── Database Client ────────────────────────────────────

export class DatabaseClient {
  private http: BasefyioFetchClient;
  private projectId: string;

  constructor(http: BasefyioFetchClient, projectId: string) {
    this.http = http;
    this.projectId = projectId;
  }

  from<T = Record<string, unknown>>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this.http, this.projectId, table);
  }

  /**
   * Execute a raw SQL query, with its values bound.
   *
   * ```ts
   * await bf.sql('UPDATE slots SET error = $1 WHERE id = $2', [message, id]);
   * ```
   *
   * **Pass values as `params`, never inside the query string.** Two things go
   * wrong when they are written in. A value can become syntax — the ordinary
   * injection — and a value can be read as an operation: the API scans the
   * statement for forbidden operations and reads string literals too, so a
   * sentence containing "copy", "grant" or "load" is refused as the operation
   * it names. Bound values are neither.
   */
  async sql<T = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<BasefyioResponse<T[]>> {
    try {
      const result = await this.http.json<SqlResult>('/sql/execute', {
        method: 'POST',
        body: toJson({
          projectId: this.projectId,
          query,
          ...(params?.length ? { params } : {}),
        }),
      });
      return { data: (result.rows ?? []) as T[], error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  async listTables(): Promise<BasefyioResponse<TableInfo[]>> {
    try {
      const data = await this.http.json<TableInfo[]>(`/projects/${this.projectId}/tables`);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }

  async getColumns(table: string): Promise<BasefyioResponse<ColumnInfo[]>> {
    try {
      const data = await this.http.json<ColumnInfo[]>(`/projects/${this.projectId}/tables/${encodeURIComponent(table)}/columns`);
      return { data, error: null };
    } catch (err: unknown) {
      return { data: null, error: toBasefyioError(err) };
    }
  }
}
