import { InferredType } from '../data-import/lib/type-inferrer';
import { DataModel, DataModelTable } from '../blueprint/blueprint.types';

const PG_TYPE: Record<InferredType, string> = {
  boolean: 'BOOLEAN',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  numeric: 'NUMERIC',
  uuid: 'UUID',
  date: 'DATE',
  timestamptz: 'TIMESTAMPTZ',
  jsonb: 'JSONB',
  text: 'TEXT',
};

function pg(type: string): string {
  return PG_TYPE[type as InferredType] ?? 'TEXT';
}

export type ChangeKind =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column_type';

export type Safety = 'safe' | 'review' | 'destructive';

export interface MigrationChange {
  kind: ChangeKind;
  table: string;
  column?: string;
  detail: string;
  safety: Safety;
}

export interface MigrationPlan {
  changes: MigrationChange[];
  /** ALTER/DROP statements to run in a transaction. */
  statements: string[];
  /** New tables, created via CollectionService.createRelationalTable on apply. */
  newTables: DataModelTable[];
  hasDestructive: boolean;
}

function q(ident: string): string {
  return `"${ident}"`;
}

function tableMap(m: DataModel): Map<string, DataModelTable> {
  return new Map((m.tables ?? []).map((t) => [t.name, t]));
}

/** Compute the schema diff from one data model to another. */
export function diffDataModels(from: DataModel, to: DataModel): MigrationPlan {
  const fromTables = tableMap(from);
  const toTables = tableMap(to);
  const changes: MigrationChange[] = [];
  const statements: string[] = [];
  const newTables: DataModelTable[] = [];

  // New tables.
  for (const [name, table] of toTables) {
    if (!fromTables.has(name)) {
      newTables.push(table);
      changes.push({
        kind: 'create_table',
        table: name,
        detail: `Create table "${name}" with ${table.columns.length} column(s)`,
        safety: 'safe',
      });
    }
  }

  // Dropped tables.
  for (const [name] of fromTables) {
    if (!toTables.has(name)) {
      statements.push(`DROP TABLE IF EXISTS "public".${q(name)} CASCADE`);
      changes.push({
        kind: 'drop_table',
        table: name,
        detail: `Drop table "${name}" (data loss)`,
        safety: 'destructive',
      });
    }
  }

  // Column-level diffs for tables present in both.
  for (const [name, toTable] of toTables) {
    const fromTable = fromTables.get(name);
    if (!fromTable) continue;
    const fromCols = new Map(fromTable.columns.map((c) => [c.name, c]));
    const toCols = new Map(toTable.columns.map((c) => [c.name, c]));

    for (const [col, c] of toCols) {
      if (!fromCols.has(col)) {
        // Always add as nullable so it succeeds on tables that already hold rows.
        statements.push(
          `ALTER TABLE "public".${q(name)} ADD COLUMN ${q(col)} ${pg(c.type)}`,
        );
        changes.push({
          kind: 'add_column',
          table: name,
          column: col,
          detail: `Add column "${col}" (${pg(c.type)})`,
          safety: 'safe',
        });
      }
    }

    for (const [col] of fromCols) {
      if (!toCols.has(col)) {
        statements.push(`ALTER TABLE "public".${q(name)} DROP COLUMN ${q(col)}`);
        changes.push({
          kind: 'drop_column',
          table: name,
          column: col,
          detail: `Drop column "${col}" (data loss)`,
          safety: 'destructive',
        });
      }
    }

    for (const [col, toCol] of toCols) {
      const fromCol = fromCols.get(col);
      if (fromCol && fromCol.type !== toCol.type) {
        statements.push(
          `ALTER TABLE "public".${q(name)} ALTER COLUMN ${q(col)} TYPE ${pg(
            toCol.type,
          )} USING ${q(col)}::${pg(toCol.type)}`,
        );
        changes.push({
          kind: 'alter_column_type',
          table: name,
          column: col,
          detail: `Change "${col}" type ${pg(fromCol.type)} → ${pg(toCol.type)} (may fail/lose data)`,
          safety: 'review',
        });
      }
    }
  }

  return {
    changes,
    statements,
    newTables,
    hasDestructive: changes.some((c) => c.safety !== 'safe'),
  };
}
