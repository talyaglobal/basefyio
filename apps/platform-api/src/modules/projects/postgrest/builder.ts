import {
  Condition,
  FieldRef,
  FilterNode,
  LogicTree,
  MAX_ROWS,
  OrderTerm,
  ParsedQuery,
  PostgrestParseError,
  SelectEmbed,
  SelectItem,
} from './types';
import { ProjectSchema, Relationship, SchemaCache, TableInfo } from './schema-cache';

/** A result column label as a quoted identifier; a JSON key may hold any character. */
function quoteLabel(label: string): string {
  return `"${label.replace(/"/g, '""')}"`;
}

/**
 * Turn a {@link ParsedQuery} into one parameterized SELECT.
 *
 * Every identifier is checked against the schema before it is written, so a
 * column or table that does not exist is a clean 400 rather than a SQL error,
 * and nothing the client sent can become SQL text. Every operand is a bind
 * parameter. Embedded resources become correlated JSON subqueries, aggregated
 * to one row or an array according to the resolved relationship.
 */
export class SelectBuilder {
  private readonly params: unknown[] = [];
  private aliasSeq = 0;

  constructor(
    private readonly schema: ProjectSchema,
    private readonly cache: SchemaCache,
  ) {}

  build(table: string, query: ParsedQuery): { sql: string; params: unknown[] } {
    const info = this.table(table);
    const alias = this.nextAlias();
    const body = this.buildSelectBody(table, alias, info, query, '');
    return { sql: body, params: this.params };
  }

  /**
   * Count rows the same filters select, for the `count` field of the response.
   *
   * The root filters count, and so does every `!inner` embed: it drops the
   * parent rows that have no matching child, so a count that ignored it would
   * report the unfiltered total next to a page of filtered rows. Every other
   * embed only changes what a row carries, never how many rows there are.
   * Ordering and paging are irrelevant to a total and are left off.
   */
  buildCount(table: string, query: ParsedQuery): { sql: string; params: unknown[] } {
    const { from } = this.countSource(table, query);
    return { sql: `SELECT COUNT(*)::int AS total ${from}`, params: this.params };
  }

  /**
   * An exact count that stops at `cap + 1` rows.
   *
   * Cheap whatever the table size — at most `cap + 1` matching rows are ever
   * visited — and exact whenever the answer is at most `cap`. A result of
   * `cap + 1` means "more than cap", and the caller falls back to the planner's
   * estimate.
   */
  buildBoundedCount(
    table: string,
    query: ParsedQuery,
    cap: number,
  ): { sql: string; params: unknown[] } {
    const { from } = this.countSource(table, query);
    const limit = this.bind(cap + 1);
    return {
      sql: `SELECT COUNT(*)::int AS total FROM (SELECT 1 ${from} LIMIT ${limit}) _bf_bounded`,
      params: this.params,
    };
  }

  /** The planner's row estimate for the same filters, read from EXPLAIN. */
  buildPlannedCount(table: string, query: ParsedQuery): { sql: string; params: unknown[] } {
    const { from } = this.countSource(table, query);
    return { sql: `EXPLAIN (FORMAT JSON) SELECT 1 ${from}`, params: this.params };
  }

  /** `FROM "t" alias WHERE …` with the root filters and the `!inner` embeds. */
  private countSource(table: string, query: ParsedQuery): { from: string } {
    const info = this.table(table);
    const alias = this.nextAlias();
    const where = [
      this.buildWhere(alias, info, query, ''),
      ...this.innerPredicates(table, alias, info, query.select, query, ''),
    ]
      .filter(Boolean)
      .join(' AND ');
    return { from: `FROM "${table}" ${alias}${where ? ` WHERE ${where}` : ''}` };
  }

  /**
   * The EXISTS predicates the `!inner` embeds among `items` impose on their
   * parent, built without any projection — what a count needs, and nothing
   * that would bind a parameter the count's SQL does not use.
   */
  private innerPredicates(
    table: string,
    alias: string,
    info: TableInfo,
    items: SelectItem[],
    query: ParsedQuery,
    pathPrefix: string,
  ): string[] {
    const out: string[] = [];
    for (const item of items) {
      if (item.kind !== 'embed' || !item.inner) continue;
      const rel = this.resolveEmbed(table, item);
      const childInfo = this.table(item.relation);
      const childAlias = this.nextAlias();
      const label = item.alias ?? item.relation;
      const childPath = pathPrefix ? `${pathPrefix}.${label}` : label;
      const join = this.embedJoin(rel, alias, childAlias, item.relation);
      const embedWhere = this.buildWhere(childAlias, childInfo, query, childPath);
      const nested = this.innerPredicates(item.relation, childAlias, childInfo, item.select, query, childPath);
      const fromJunction = rel.junction ? this.junctionFrom(rel, alias, childAlias) : '';
      out.push(this.existsSql(item.relation, childAlias, fromJunction, [join, embedWhere, ...nested]));
    }
    return out;
  }

  private existsSql(relation: string, alias: string, fromJunction: string, conditions: string[]): string {
    const where = conditions.filter(Boolean).join(' AND ');
    return (
      `EXISTS (SELECT 1 FROM "${relation}" ${alias}` +
      (fromJunction ? ` ${fromJunction}` : '') +
      (where ? ` WHERE ${where}` : '') +
      `)`
    );
  }

  private resolveEmbed(parentTable: string, embed: SelectEmbed): Relationship {
    const rel = this.cache.resolveRelationship(
      this.schema,
      parentTable,
      embed.relation,
      embed.hint,
    );
    if (!rel) {
      throw new PostgrestParseError(
        `Could not find a relationship between "${parentTable}" and "${embed.relation}"` +
          (embed.hint ? ` using hint "${embed.hint}"` : ''),
        'Define a foreign key, or disambiguate with a hint.',
        'PGRST200',
      );
    }
    return rel;
  }

  /**
   * The WHERE clause for a statement that changes rows.
   *
   * UPDATE and DELETE want the same filter language a read has — or/and/not,
   * casts, JSON paths, the whole operator set — and none of the rest of it:
   * no embeds, no ordering, no paging. Postgres accepts an alias on both
   * statements, so the clause comes out exactly as it does for a select and
   * the statement reads `UPDATE "t" AS _bf0 SET … WHERE _bf0."x" = $1`.
   *
   * Returns an empty clause when the query carries no filter. The caller
   * decides what that means; for a write it means refusing, since an
   * unfiltered UPDATE or DELETE takes the whole table.
   */
  buildWriteWhere(
    table: string,
    query: ParsedQuery,
  ): { alias: string; where: string; params: unknown[] } {
    const info = this.table(table);
    const alias = this.nextAlias();
    const where = this.buildWhere(alias, info, query, '');
    return { alias, where, params: this.params };
  }

  /** The parameters accumulated so far, exposed for callers that compose counts. */
  get boundParams(): unknown[] {
    return this.params;
  }

  private bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  private nextAlias(): string {
    return `_bf${this.aliasSeq++}`;
  }

  private table(name: string): TableInfo {
    const info = this.schema.tables.get(name);
    if (!info) {
      throw new PostgrestParseError(
        `Relation "${name}" not found`,
        undefined,
        'PGRST205',
      );
    }
    return info;
  }

  /* ─────────────────────────── field / select rendering ─────────────────────── */

  private assertColumn(info: TableInfo, column: string): void {
    if (!info.columns.has(column)) {
      throw new PostgrestParseError(
        `Column "${column}" does not exist on "${info.name}"`,
        undefined,
        'PGRST204',
      );
    }
  }

  private fieldSql(alias: string, info: TableInfo, field: FieldRef): string {
    this.assertColumn(info, field.column);
    let expr = `${alias}."${field.column}"`;
    for (const step of field.jsonPath) {
      expr = `${expr}${step.op}${this.bind(step.key)}`;
    }
    return expr;
  }

  private buildSelectList(
    table: string,
    alias: string,
    info: TableInfo,
    items: SelectItem[],
    query: ParsedQuery,
    pathPrefix: string,
    innerPredicates: string[],
  ): string[] {
    const out: string[] = [];
    for (const item of items) {
      if (item.kind === 'star') {
        out.push(`${alias}.*`);
      } else if (item.kind === 'column') {
        let expr = this.fieldSql(alias, info, item.field);
        if (item.cast) expr = `(${expr})::"${item.cast}"`;
        // A JSON path is labelled by its last key, as PostgREST does:
        // `meta->>color` comes back as "color", not as the column it came from.
        const path = item.field.jsonPath;
        const label = item.alias ?? (path.length ? path[path.length - 1].key : item.field.column);
        out.push(`${expr} AS ${quoteLabel(label)}`);
      } else {
        out.push(this.buildEmbed(table, alias, info, item, query, pathPrefix, innerPredicates));
      }
    }
    return out;
  }

  private buildSelectBody(
    table: string,
    alias: string,
    info: TableInfo,
    query: ParsedQuery,
    pathPrefix: string,
  ): string {
    // `!inner` embeds contribute an EXISTS predicate on this relation, so a
    // parent row with no matching child is dropped — collected here because the
    // predicate belongs in this query's WHERE, not the embed's subquery.
    const innerPredicates: string[] = [];
    const cols = this.buildSelectList(table, alias, info, query.select, query, pathPrefix, innerPredicates);
    const rootWhere = this.buildWhere(alias, info, query, pathPrefix);
    const where = [rootWhere, ...innerPredicates].filter(Boolean).join(' AND ');
    const order = this.buildOrder(alias, info, query, pathPrefix);
    const paging = this.buildPaging(query, pathPrefix);

    return [
      `SELECT ${cols.join(', ')}`,
      `FROM "${table}" ${alias}`,
      where ? `WHERE ${where}` : '',
      order ? `ORDER BY ${order}` : '',
      paging,
    ]
      .filter(Boolean)
      .join(' ');
  }

  /* ─────────────────────────────── embeds ──────────────────────────────────── */

  private buildEmbed(
    parentTable: string,
    parentAlias: string,
    parentInfo: TableInfo,
    embed: SelectEmbed,
    query: ParsedQuery,
    pathPrefix: string,
    innerPredicates: string[],
  ): string {
    const rel = this.resolveEmbed(parentTable, embed);

    const childInfo = this.table(embed.relation);
    const childAlias = this.nextAlias();
    const label = embed.alias ?? embed.relation;
    const childPath = pathPrefix ? `${pathPrefix}.${label}` : label;

    const nestedInner: string[] = [];
    const cols = this.buildSelectList(
      embed.relation,
      childAlias,
      childInfo,
      embed.select,
      query,
      childPath,
      nestedInner,
    );

    // Join condition links the embed back to the parent row.
    const join = this.embedJoin(rel, parentAlias, childAlias, embed.relation);

    const embedWhere = this.buildWhere(childAlias, childInfo, query, childPath);
    const conditions = [join, embedWhere, ...nestedInner].filter(Boolean).join(' AND ');
    const order = this.buildOrder(childAlias, childInfo, query, childPath);
    const paging = this.buildPaging(query, childPath);

    const fromJunction = rel.junction ? this.junctionFrom(rel, parentAlias, childAlias) : '';

    const inner = [
      `SELECT ${cols.join(', ')}`,
      `FROM "${embed.relation}" ${childAlias}`,
      fromJunction,
      conditions ? `WHERE ${conditions}` : '',
      order ? `ORDER BY ${order}` : '',
      paging,
    ]
      .filter(Boolean)
      .join(' ');

    // `!inner` keeps only parent rows that have a match: the same correlated
    // query without the projection, asserted to exist.
    if (embed.inner) {
      innerPredicates.push(
        this.existsSql(embed.relation, childAlias, fromJunction, [join, embedWhere, ...nestedInner]),
      );
    }

    const rowAlias = this.nextAlias();
    if (rel.cardinality === 'toOne') {
      return `(SELECT row_to_json(${rowAlias}) FROM (${inner}) ${rowAlias}) AS "${label}"`;
    }
    // to-many and many-to-many return an array, never null.
    return `(SELECT COALESCE(json_agg(${rowAlias}), '[]'::json) FROM (${inner}) ${rowAlias}) AS "${label}"`;
  }

  private embedJoin(
    rel: Relationship,
    parentAlias: string,
    childAlias: string,
    childTable: string,
  ): string {
    if (rel.junction) {
      // The join to the junction is emitted in junctionFrom; here we link the
      // junction's child side to the embedded table.
      return rel.junction.childColumns
        .map(
          (jc, i) =>
            `_j."${jc}" = ${childAlias}."${rel.foreign[i] ?? rel.foreign[0]}"`,
        )
        .join(' AND ');
    }
    if (rel.cardinality === 'toOne') {
      // parent.local = child.foreign
      return rel.local
        .map((lc, i) => `${parentAlias}."${lc}" = ${childAlias}."${rel.foreign[i]}"`)
        .join(' AND ');
    }
    // toMany: child.foreign = parent.local
    return rel.foreign
      .map((fc, i) => `${childAlias}."${fc}" = ${parentAlias}."${rel.local[i]}"`)
      .join(' AND ');
  }

  private junctionFrom(rel: Relationship, parentAlias: string, childAlias: string): string {
    const j = rel.junction!;
    const link = j.parentColumns
      .map((pc, i) => `_j."${pc}" = ${parentAlias}."${rel.local[i] ?? rel.local[0]}"`)
      .join(' AND ');
    return `JOIN "${j.table}" _j ON ${link}`;
  }

  /* ─────────────────────────────── filters ─────────────────────────────────── */

  private buildWhere(
    alias: string,
    info: TableInfo,
    query: ParsedQuery,
    path: string,
  ): string {
    const nodes = query.filters.get(path) ?? [];
    if (!nodes.length) return '';
    return nodes.map((n) => this.filterSql(alias, info, n)).join(' AND ');
  }

  private filterSql(alias: string, info: TableInfo, node: FilterNode): string {
    if (node.kind === 'logic') return this.logicSql(alias, info, node);
    return this.conditionSql(alias, info, node);
  }

  private logicSql(alias: string, info: TableInfo, node: LogicTree): string {
    const parts = node.children.map((c) => this.filterSql(alias, info, c));
    const joined = `(${parts.join(` ${node.op.toUpperCase()} `)})`;
    return node.negate ? `NOT ${joined}` : joined;
  }

  private conditionSql(alias: string, info: TableInfo, cond: Condition): string {
    const lhs = this.fieldSql(alias, info, cond.field);
    const sql = this.operatorSql(lhs, cond);
    return cond.negate ? `NOT (${sql})` : sql;
  }

  private operatorSql(lhs: string, cond: Condition): string {
    const { op, value } = cond;

    switch (op) {
      case 'eq':
        return `${lhs} = ${this.bind(value)}`;
      case 'neq':
        return `${lhs} <> ${this.bind(value)}`;
      case 'gt':
        return `${lhs} > ${this.bind(value)}`;
      case 'gte':
        return `${lhs} >= ${this.bind(value)}`;
      case 'lt':
        return `${lhs} < ${this.bind(value)}`;
      case 'lte':
        return `${lhs} <= ${this.bind(value)}`;
      case 'like':
        return `${lhs} LIKE ${this.bind(this.likePattern(value))}`;
      case 'ilike':
        return `${lhs} ILIKE ${this.bind(this.likePattern(value))}`;
      case 'match':
        return `${lhs} ~ ${this.bind(value)}`;
      case 'imatch':
        return `${lhs} ~* ${this.bind(value)}`;
      case 'is':
        return `${lhs} IS ${this.isOperand(value)}`;
      case 'isdistinct':
        return `${lhs} IS DISTINCT FROM ${this.bind(value)}`;
      case 'in': {
        const items = this.inList(value);
        if (items.length === 0) return 'FALSE'; // `in.()` matches nothing
        // Bind each element separately rather than as an array: with the column
        // on the left of IN, Postgres infers each parameter's type from it, so a
        // list of string operands works against an integer or uuid column. An
        // array bind would be typed text[] and fail that comparison.
        const ph = items.map((v) => this.bind(v)).join(', ');
        return `${lhs} IN (${ph})`;
      }
      case 'fts':
      case 'plfts':
      case 'phfts':
      case 'wfts':
        return this.ftsSql(lhs, cond);
      case 'cs':
        return `${lhs} @> ${this.bind(this.arrayOrJson(value))}`;
      case 'cd':
        return `${lhs} <@ ${this.bind(this.arrayOrJson(value))}`;
      case 'ov':
        return `${lhs} && ${this.bind(this.arrayOrJson(value))}`;
      case 'sl':
        return `${lhs} << ${this.bind(value)}`;
      case 'sr':
        return `${lhs} >> ${this.bind(value)}`;
      case 'nxl':
        return `${lhs} &> ${this.bind(value)}`;
      case 'nxr':
        return `${lhs} &< ${this.bind(value)}`;
      case 'adj':
        return `${lhs} -|- ${this.bind(value)}`;
      default:
        throw new PostgrestParseError(`Unsupported operator "${op}"`);
    }
  }

  private likePattern(value: string): string {
    return value.replace(/\*/g, '%');
  }

  private isOperand(value: string): string {
    switch (value.toLowerCase()) {
      case 'null':
        return 'NULL';
      case 'true':
        return 'TRUE';
      case 'false':
        return 'FALSE';
      case 'unknown':
        return 'UNKNOWN';
      default:
        throw new PostgrestParseError(`"is" expects null, true, false or unknown, got "${value}"`);
    }
  }

  private inList(value: string): string[] {
    const body = value.replace(/^\(/, '').replace(/\)$/, '');
    if (body.trim() === '') return [];
    // Split on commas outside quotes; strip surrounding quotes from each item.
    const items: string[] = [];
    let cur = '';
    let quote: string | null = null;
    for (const ch of body) {
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ',') {
        items.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    items.push(cur);
    return items.map((s) => s.trim());
  }

  private arrayOrJson(value: string): string {
    // Postgres accepts the literal form for both array (`{a,b}`) and range
    // (`[1,10)`); pass it through as a bound literal for the column's own type
    // to interpret.
    return value;
  }

  private ftsSql(lhs: string, cond: Condition): string {
    const fn =
      cond.op === 'plfts'
        ? 'plainto_tsquery'
        : cond.op === 'phfts'
          ? 'phraseto_tsquery'
          : cond.op === 'wfts'
            ? 'websearch_to_tsquery'
            : 'to_tsquery';
    if (cond.ftsConfig) {
      return `${lhs} @@ ${fn}(${this.bind(cond.ftsConfig)}::regconfig, ${this.bind(cond.value)})`;
    }
    return `${lhs} @@ ${fn}(${this.bind(cond.value)})`;
  }

  /* ─────────────────────────── order / paging ──────────────────────────────── */

  private buildOrder(
    alias: string,
    info: TableInfo,
    query: ParsedQuery,
    path: string,
  ): string {
    const terms = query.order.get(path);
    if (!terms?.length) return '';
    return terms.map((t) => this.orderTermSql(alias, info, t)).join(', ');
  }

  /**
   * One ORDER BY term.
   *
   * Without `.nullsfirst` / `.nullslast` the term leaves NULL placement to
   * PostgreSQL, whose default is NULLS LAST ascending and NULLS FIRST
   * descending — the order PostgREST, psql and every SQL client give. This API
   * used to invert it, so the same query listed its NULLs at the other end.
   */
  private orderTermSql(alias: string, info: TableInfo, term: OrderTerm): string {
    const expr = this.fieldSql(alias, info, term.field);
    const dir = term.dir === 'desc' ? 'DESC' : 'ASC';
    const nulls =
      term.nulls === 'first' ? ' NULLS FIRST' : term.nulls === 'last' ? ' NULLS LAST' : '';
    return `${expr} ${dir}${nulls}`;
  }

  private buildPaging(query: ParsedQuery, path: string): string {
    const parts: string[] = [];
    const limit = query.limit.get(path);
    if (limit !== undefined) parts.push(`LIMIT ${this.bind(limit)}`);
    else if (path === '') parts.push(`LIMIT ${this.bind(MAX_ROWS)}`);
    const offset = query.offset.get(path);
    if (offset !== undefined) parts.push(`OFFSET ${this.bind(offset)}`);
    return parts.join(' ');
  }
}
