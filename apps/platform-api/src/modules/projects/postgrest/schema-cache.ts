import { PoolClient } from 'pg';

/**
 * What the query builder needs to know about a project's schema that the URL
 * cannot tell it: which columns a table has, and how two tables are related.
 *
 * Embedding one resource in another — `select=*,author:users(name)` — only works
 * if the foreign key between them is known, and resolving it in the database on
 * every request would be wasteful. This caches the catalogue per project and
 * refreshes it when a relationship a request names cannot be found, which is the
 * signal that the schema changed under us.
 */

export interface ForeignKey {
  /** Table the FK is declared on. */
  table: string;
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  constraint: string;
}

export interface TableInfo {
  name: string;
  columns: Set<string>;
  primaryKey: string[];
}

export interface ProjectSchema {
  tables: Map<string, TableInfo>;
  /** Every FK, in both directions are discoverable by scanning table/foreignTable. */
  foreignKeys: ForeignKey[];
  loadedAt: number;
}

/**
 * A resolved relationship between a parent relation and an embedded one.
 *
 * `cardinality` decides how the embed is aggregated: a parent that points at the
 * child (`toOne`) yields one row (`row_to_json`); a child that points back
 * (`toMany`) yields an array (`json_agg`). `local`/`foreign` are the join
 * columns, parent-side and embed-side respectively.
 */
export interface Relationship {
  cardinality: 'toOne' | 'toMany' | 'manyToMany';
  local: string[];
  foreign: string[];
  /** For many-to-many: the junction table and its two FK sides. */
  junction?: {
    table: string;
    parentColumns: string[];
    childColumns: string[];
  };
}

const TTL_MS = 60_000;

export class SchemaCache {
  private readonly byProject = new Map<string, ProjectSchema>();

  /** Drop a project's cached schema, forcing a reload on the next request. */
  invalidate(projectId: string): void {
    this.byProject.delete(projectId);
  }

  async get(projectId: string, client: PoolClient, force = false): Promise<ProjectSchema> {
    const existing = this.byProject.get(projectId);
    if (!force && existing && Date.now() - existing.loadedAt < TTL_MS) {
      return existing;
    }
    const schema = await this.load(client);
    this.byProject.set(projectId, schema);
    return schema;
  }

  private async load(client: PoolClient): Promise<ProjectSchema> {
    const tables = new Map<string, TableInfo>();

    const cols = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'`,
    );
    for (const row of cols.rows) {
      let t = tables.get(row.table_name);
      if (!t) {
        t = { name: row.table_name, columns: new Set(), primaryKey: [] };
        tables.set(row.table_name, t);
      }
      t.columns.add(row.column_name);
    }

    const pks = await client.query<{ table_name: string; column_name: string }>(
      `select tc.table_name, kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
        where tc.table_schema = 'public'
          and tc.constraint_type = 'PRIMARY KEY'
        order by kcu.ordinal_position`,
    );
    for (const row of pks.rows) {
      tables.get(row.table_name)?.primaryKey.push(row.column_name);
    }

    // Foreign keys, with their ordered column pairs collapsed per constraint.
    const fks = await client.query<{
      constraint: string;
      table: string;
      column: string;
      foreign_table: string;
      foreign_column: string;
    }>(
      `select con.conname as constraint,
              cl.relname  as table,
              att.attname as column,
              fcl.relname as foreign_table,
              fatt.attname as foreign_column,
              ord.n as ord
         from pg_constraint con
         join pg_class cl   on cl.oid  = con.conrelid
         join pg_class fcl  on fcl.oid = con.confrelid
         join pg_namespace ns on ns.oid = cl.relnamespace
         join lateral unnest(con.conkey, con.confkey)
                      with ordinality as ord(src, tgt, n) on true
         join pg_attribute att  on att.attrelid  = con.conrelid  and att.attnum  = ord.src
         join pg_attribute fatt on fatt.attrelid = con.confrelid and fatt.attnum = ord.tgt
        where con.contype = 'f' and ns.nspname = 'public'
        order by con.conname, ord.n`,
    );

    const fkMap = new Map<string, ForeignKey>();
    for (const row of fks.rows) {
      let fk = fkMap.get(row.constraint);
      if (!fk) {
        fk = {
          table: row.table,
          columns: [],
          foreignTable: row.foreign_table,
          foreignColumns: [],
          constraint: row.constraint,
        };
        fkMap.set(row.constraint, fk);
      }
      fk.columns.push(row.column);
      fk.foreignColumns.push(row.foreign_column);
    }

    return { tables, foreignKeys: [...fkMap.values()], loadedAt: Date.now() };
  }

  /**
   * Work out how `embedRelation` hangs off `parentTable`.
   *
   * Tried in the order PostgREST uses: a forward FK (parent → embed, one row),
   * a back FK (embed → parent, many rows), then a junction table for
   * many-to-many. A hint — an FK constraint name, an FK column, or a junction
   * table name — disambiguates when more than one path exists. Returns null when
   * nothing connects them, which the caller turns into a clear error naming both.
   */
  resolveRelationship(
    schema: ProjectSchema,
    parentTable: string,
    embedRelation: string,
    hint?: string,
  ): Relationship | null {
    const forward = schema.foreignKeys.filter(
      (fk) => fk.table === parentTable && fk.foreignTable === embedRelation,
    );
    const backward = schema.foreignKeys.filter(
      (fk) => fk.table === embedRelation && fk.foreignTable === parentTable,
    );

    if (hint) {
      const f = forward.find((fk) => fk.constraint === hint || fk.columns.includes(hint));
      if (f) return { cardinality: 'toOne', local: f.columns, foreign: f.foreignColumns };
      const b = backward.find((fk) => fk.constraint === hint || fk.columns.includes(hint));
      if (b) return { cardinality: 'toMany', local: b.foreignColumns, foreign: b.columns };
      const m2m = this.resolveManyToMany(schema, parentTable, embedRelation, hint);
      if (m2m) return m2m;
    }

    if (forward.length === 1 && backward.length === 0) {
      const f = forward[0];
      return { cardinality: 'toOne', local: f.columns, foreign: f.foreignColumns };
    }
    if (backward.length === 1 && forward.length === 0) {
      const b = backward[0];
      return { cardinality: 'toMany', local: b.foreignColumns, foreign: b.columns };
    }
    // Exactly one of each is still unambiguous: the forward FK is the to-one, the
    // back FK the to-many — but they are different relationships, so a hint is
    // required to choose. Fall through to m2m / null unless a single path exists.
    if (forward.length === 1 && backward.length === 1) {
      return null; // ambiguous without a hint
    }

    return this.resolveManyToMany(schema, parentTable, embedRelation);
  }

  private resolveManyToMany(
    schema: ProjectSchema,
    parentTable: string,
    embedRelation: string,
    junctionHint?: string,
  ): Relationship | null {
    // A junction has an FK to the parent and an FK to the child. Find a table
    // that references both; a hint pins the junction when several qualify.
    const candidates = new Map<string, { toParent: ForeignKey; toChild: ForeignKey }>();
    for (const toParent of schema.foreignKeys) {
      if (toParent.foreignTable !== parentTable) continue;
      for (const toChild of schema.foreignKeys) {
        if (toChild.table !== toParent.table) continue;
        if (toChild.foreignTable !== embedRelation) continue;
        candidates.set(toParent.table, { toParent, toChild });
      }
    }
    let chosen = junctionHint ? candidates.get(junctionHint) : undefined;
    if (!chosen && candidates.size === 1) chosen = [...candidates.values()][0];
    if (!chosen) return null;

    return {
      cardinality: 'manyToMany',
      local: chosen.toParent.foreignColumns,
      foreign: chosen.toChild.foreignColumns,
      junction: {
        table: chosen.toParent.table,
        parentColumns: chosen.toParent.columns,
        childColumns: chosen.toChild.columns,
      },
    };
  }
}
