import type { BasefyioFetchClient } from '../lib/fetch.js';
import type {
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

// ── Query Builder ───────────────────────────────────────

type Operation = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

export class QueryBuilder<T = Record<string, unknown>> implements PromiseLike<BasefyioResponse<T[]>> {
  private http: BasefyioFetchClient;
  private projectId: string;
  private _table: string;
  private _op: Operation = 'select';
  private _selectCols = '*';
  private _insertRows: Record<string, unknown>[] = [];
  private _updateData: Record<string, unknown> = {};
  private _upsertConflict: string[] = [];
  private _filters: Filter[] = [];
  private _or: OrFilter[][] = [];
  private _orRaw: string[] = [];
  private _orders: OrderClause[] = [];
  private _limit?: number;
  private _offset?: number;
  private _single = false;
  private _count: 'exact' | null = null;

  constructor(http: BasefyioFetchClient, projectId: string, table: string) {
    this.http = http;
    this.projectId = projectId;
    this._table = table;
  }

  // ── Operations ───────────────────────────────────────

  select(columns = '*'): this {
    this._op = 'select';
    this._selectCols = columns;
    return this;
  }

  insert(data: Partial<T> | Partial<T>[]): this {
    this._op = 'insert';
    this._insertRows = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data: Partial<T>): this {
    this._op = 'update';
    this._updateData = data as Record<string, unknown>;
    return this;
  }

  delete(): this {
    this._op = 'delete';
    return this;
  }

  upsert(data: Partial<T> | Partial<T>[], options?: { onConflict?: string | string[] }): this {
    this._op = 'upsert';
    this._insertRows = Array.isArray(data) ? data : [data];
    const conflict = options?.onConflict;
    this._upsertConflict = conflict
      ? (Array.isArray(conflict) ? conflict : conflict.split(',').map((s) => s.trim()))
      : [];
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

  single(): QueryBuilder<T> {
    this._single = true;
    this._limit = 1;
    return this;
  }

  maybeSingle(): QueryBuilder<T> {
    this._single = true;
    this._limit = 1;
    return this;
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

  private buildWhereClause(bind: Binder): string {
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

    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
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
    if (this._offset !== undefined) s += ` OFFSET ${countLiteral(this._offset, 'offset')}`;
    return s;
  }

  /** The statement, with every value handed to `bind`. One builder, two modes. */
  private build(bind: Binder): string {
    const table = quoteIdent(this._table);

    switch (this._op) {
      case 'select': {
        const cols = this._selectCols === '*'
          ? '*'
          : this._selectCols.split(',').map((c) => quoteIdent(c.trim())).join(', ');
        return `SELECT ${cols} FROM ${table}${this.buildWhereClause(bind)}${this.buildOrderClause()}${this.buildLimitOffset()}`;
      }

      case 'insert': {
        if (!this._insertRows.length) throw new Error('No data to insert');
        const allKeys = [...new Set(this._insertRows.flatMap(Object.keys))];
        const cols = allKeys.map(quoteIdent).join(', ');
        const rows = this._insertRows.map((row) => {
          const vals = allKeys.map((k) => bind(row[k] ?? null));
          return `(${vals.join(', ')})`;
        });
        return `INSERT INTO ${table} (${cols}) VALUES ${rows.join(', ')} RETURNING *`;
      }

      case 'update': {
        const sets = Object.entries(this._updateData)
          .map(([k, v]) => `${quoteIdent(k)} = ${bind(v)}`)
          .join(', ');
        if (!sets) throw new Error('No data to update');
        return `UPDATE ${table} SET ${sets}${this.buildWhereClause(bind)} RETURNING *`;
      }

      case 'delete': {
        return `DELETE FROM ${table}${this.buildWhereClause(bind)} RETURNING *`;
      }

      case 'upsert': {
        if (!this._insertRows.length) throw new Error('No data to upsert');
        const allKeys = [...new Set(this._insertRows.flatMap(Object.keys))];
        const cols = allKeys.map(quoteIdent).join(', ');
        const rows = this._insertRows.map((row) => {
          const vals = allKeys.map((k) => bind(row[k] ?? null));
          return `(${vals.join(', ')})`;
        });
        const conflict = this._upsertConflict.length
          ? this._upsertConflict.map(quoteIdent).join(', ')
          : allKeys[0] ? quoteIdent(allKeys[0]) : 'id';
        const updateCols = allKeys
          .filter((k) => !this._upsertConflict.includes(k))
          .map((k) => `${quoteIdent(k)} = EXCLUDED.${quoteIdent(k)}`)
          .join(', ');
        return `INSERT INTO ${table} (${cols}) VALUES ${rows.join(', ')} ON CONFLICT (${conflict}) DO UPDATE SET ${updateCols} RETURNING *`;
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

  private async execute(): Promise<BasefyioResponse<T[]>> {
    try {
      const { text, params } = this.toQuery();
      const result = await this.http.json<SqlResult>('/sql/execute', {
        method: 'POST',
        // `params` rides along only when there are any, so a query carrying no
        // values sends byte-for-byte the request it always did — and still
        // works against an API that has never heard of parameters.
        body: JSON.stringify({
          projectId: this.projectId,
          query: text,
          ...(params.length ? { params } : {}),
        }),
      });

      const rows = (result.rows ?? []) as T[];

      if (this._single) {
        if (rows.length === 0) {
          return { data: null, error: null } as BasefyioResponse<T[]>;
        }
        return { data: rows[0] as any, error: null };
      }

      return { data: rows, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  then<TResult1 = BasefyioResponse<T[]>, TResult2 = never>(
    onfulfilled?: ((value: BasefyioResponse<T[]>) => TResult1 | PromiseLike<TResult1>) | null,
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
        body: JSON.stringify({
          projectId: this.projectId,
          query,
          ...(params?.length ? { params } : {}),
        }),
      });
      return { data: (result.rows ?? []) as T[], error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async listTables(): Promise<BasefyioResponse<TableInfo[]>> {
    try {
      const data = await this.http.json<TableInfo[]>(`/projects/${this.projectId}/tables`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async getColumns(table: string): Promise<BasefyioResponse<ColumnInfo[]>> {
    try {
      const data = await this.http.json<ColumnInfo[]>(`/projects/${this.projectId}/tables/${encodeURIComponent(table)}/columns`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }
}
