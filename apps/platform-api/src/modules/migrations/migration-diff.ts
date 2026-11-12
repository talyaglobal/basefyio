import { InferredType } from '../data-import/lib/type-inferrer';
import { DataModel, DataModelTable } from '../blueprint/blueprint.types';
import {
  buildForeignKey,
  fkName,
  hasGeneratedKey,
  pgType,
  pkName,
  qi,
  qualified,
  uniqueName,
} from '../blueprint/blueprint-ddl';
import type { LiveSchema, LiveTable } from '../blueprint/blueprint-db';

export type ChangeKind =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column_type'
  | 'alter_nullability'
  | 'alter_primary_key'
  | 'add_unique'
  | 'drop_unique'
  | 'add_foreign_key'
  | 'drop_foreign_key';

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
  /** ALTER/DROP statements to run in a transaction (after newTables are created). */
  statements: string[];
  /** New tables, created (with keys, access policies and data) on apply. */
  newTables: DataModelTable[];
  hasDestructive: boolean;
  /** Things deliberately left alone, e.g. columns added outside the blueprint. */
  notes?: string[];
  /** The data model this plan brings the database to; becomes the snapshot on apply. */
  targetModel?: DataModel;
}

/** information_schema data_type → the model's logical type (null = not one we generate). */
const LOGICAL_TYPE: Record<string, InferredType> = {
  boolean: 'boolean',
  integer: 'integer',
  bigint: 'bigint',
  numeric: 'numeric',
  uuid: 'uuid',
  date: 'date',
  'timestamp with time zone': 'timestamptz',
  jsonb: 'jsonb',
  text: 'text',
};

const SYSTEM_TIMESTAMPS = new Set(['created_at', 'updated_at']);

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Statements run in this order so each step finds what it needs. */
const PHASES = [
  'dropFk',
  'dropUnique',
  'dropTable',
  'dropColumn',
  'addColumn',
  'alterType',
  'nullability',
  'primaryKey',
  'addUnique',
  'addFk',
] as const;
type Phase = (typeof PHASES)[number];

/**
 * Plan the changes that bring the project's tables to the target model.
 *
 * The "from" side is the live database, so a model that drifted from the
 * real tables (an earlier failed or partial generation, edits in the Table
 * Editor) still yields the right plan. The snapshot — the model as last
 * generated or migrated — decides ownership: only tables, columns and
 * constraints the blueprint created are ever dropped; anything else found in
 * the database is left alone and listed in `notes`.
 */
export function planSchemaChanges(input: {
  target: DataModel;
  live: LiveSchema;
  snapshot: DataModel | null;
}): MigrationPlan {
  const { target, live } = input;
  const snapshot = input.snapshot ?? { tables: [] };
  const snapTables = new Map(snapshot.tables.map((t) => [t.name, t]));
  const targetTables = new Map(target.tables.map((t) => [t.name, t]));
  const changes: MigrationChange[] = [];
  const byPhase = new Map<Phase, string[]>(PHASES.map((p) => [p, []]));
  const notes: string[] = [];
  const newTables: DataModelTable[] = [];
  const add = (phase: Phase, sql: string, change?: MigrationChange) => {
    (byPhase.get(phase) as string[]).push(sql);
    if (change) changes.push(change);
  };

  for (const t of target.tables) {
    if (live.has(t.name)) continue;
    newTables.push(t);
    changes.push({
      kind: 'create_table',
      table: t.name,
      detail: `Create table "${t.name}" with ${t.columns.length} column(s)`,
      safety: 'safe',
    });
    for (const fk of t.foreignKeys ?? []) {
      add('addFk', buildForeignKey(t.name, fk), {
        kind: 'add_foreign_key',
        table: t.name,
        column: fk.column,
        detail: `Add reference "${fk.column}" → ${fk.refTable}.${fk.refColumn}`,
        safety: 'safe',
      });
    }
  }

  for (const s of snapshot.tables) {
    if (targetTables.has(s.name) || !live.has(s.name)) continue;
    add('dropTable', `DROP TABLE IF EXISTS ${qualified(s.name)} CASCADE`, {
      kind: 'drop_table',
      table: s.name,
      detail: `Drop table "${s.name}" (data loss)`,
      safety: 'destructive',
    });
  }

  for (const t of target.tables) {
    const l = live.get(t.name);
    if (!l) continue;
    diffTable(t, l, snapTables.get(t.name) ?? null, add, notes);
  }

  const statements = PHASES.flatMap((p) => byPhase.get(p) as string[]);
  return {
    changes,
    statements,
    newTables,
    hasDestructive: changes.some((c) => c.safety !== 'safe'),
    ...(notes.length ? { notes } : {}),
  };
}

function diffTable(
  t: DataModelTable,
  l: LiveTable,
  snap: DataModelTable | null,
  add: (phase: Phase, sql: string, change?: MigrationChange) => void,
  notes: string[],
): void {
  const name = t.name;
  const T = qualified(name);
  const liveCols = new Map(l.columns.map((c) => [c.name, c]));
  const snapCols = new Map((snap?.columns ?? []).map((c) => [c.name, c]));
  const targetCols = new Map(t.columns.map((c) => [c.name, c]));
  const generatedKey = hasGeneratedKey(t);
  const isSystem = (col: string) => SYSTEM_TIMESTAMPS.has(col) || (generatedKey && col === 'id');

  // ── Columns ──
  for (const c of t.columns) {
    const lc = liveCols.get(c.name);
    if (!lc) {
      // Always nullable, so it succeeds on a table that already holds rows.
      add('addColumn', `ALTER TABLE ${T} ADD COLUMN ${qi(c.name)} ${pgType(c.type)}`, {
        kind: 'add_column',
        table: name,
        column: c.name,
        detail: `Add column "${c.name}" (${pgType(c.type)})`,
        safety: 'safe',
      });
      continue;
    }
    const liveType = LOGICAL_TYPE[lc.dataType] ?? null;
    const snapType = snapCols.get(c.name)?.type;
    const differs = liveType
      ? pgType(liveType) !== pgType(c.type)
      : snapType !== undefined && snapType !== c.type;
    if (differs) {
      add(
        'alterType',
        `ALTER TABLE ${T} ALTER COLUMN ${qi(c.name)} TYPE ${pgType(c.type)} USING ${qi(c.name)}::${pgType(c.type)}`,
        {
          kind: 'alter_column_type',
          table: name,
          column: c.name,
          detail: `Change "${c.name}" type ${liveType ? pgType(liveType) : lc.dataType} → ${pgType(c.type)} (may fail or lose data)`,
          safety: 'review',
        },
      );
    }
    // Nullability follows deliberate edits of the model only, so a column the
    // plan added as nullable is not flagged again on every plan.
    const snapCol = snapCols.get(c.name);
    const isPk = (t.primaryKey ?? []).includes(c.name);
    if (!isPk && snapCol && snapCol.nullable !== c.nullable) {
      if (c.nullable && !lc.nullable) {
        add('nullability', `ALTER TABLE ${T} ALTER COLUMN ${qi(c.name)} DROP NOT NULL`, {
          kind: 'alter_nullability',
          table: name,
          column: c.name,
          detail: `Allow empty values in "${c.name}"`,
          safety: 'safe',
        });
      } else if (!c.nullable && lc.nullable) {
        add('nullability', `ALTER TABLE ${T} ALTER COLUMN ${qi(c.name)} SET NOT NULL`, {
          kind: 'alter_nullability',
          table: name,
          column: c.name,
          detail: `Require a value in "${c.name}" (fails if rows have none)`,
          safety: 'review',
        });
      }
    }
  }
  for (const lc of l.columns) {
    if (targetCols.has(lc.name) || isSystem(lc.name)) continue;
    if (snapCols.has(lc.name)) {
      add('dropColumn', `ALTER TABLE ${T} DROP COLUMN ${qi(lc.name)}`, {
        kind: 'drop_column',
        table: name,
        column: lc.name,
        detail: `Drop column "${lc.name}" (data loss)`,
        safety: 'destructive',
      });
    } else if (!(lc.name === 'id' && !generatedKey && !targetCols.has('id'))) {
      notes.push(`"${name}.${lc.name}" is not part of the model; it was left unchanged.`);
    }
  }

  // ── Primary key ──
  const livePk = l.constraints.find((c) => c.type === 'p');
  const wantPk = generatedKey ? ['id'] : (t.primaryKey as string[]);
  if (!livePk || !sameList(livePk.columns, wantPk)) {
    const parts: string[] = [];
    if (generatedKey && !liveCols.has('id')) {
      parts.push(`ALTER TABLE ${T} ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid()`);
    }
    if (livePk) parts.push(`ALTER TABLE ${T} DROP CONSTRAINT ${qi(livePk.name)}`);
    parts.push(`ALTER TABLE ${T} ADD CONSTRAINT ${qi(pkName(name))} PRIMARY KEY (${wantPk.map(qi).join(', ')})`);
    for (const sql of parts.slice(0, -1)) add('primaryKey', sql);
    add('primaryKey', parts[parts.length - 1], {
      kind: 'alter_primary_key',
      table: name,
      detail: generatedKey
        ? `Use a generated "id" as the primary key${livePk ? ` instead of (${livePk.columns.join(', ')})` : ''}`
        : `Make (${wantPk.join(', ')}) the primary key${livePk ? ` instead of (${livePk.columns.join(', ')})` : ''} (fails on empty or repeated values)`,
      safety: 'review',
    });
  }

  // ── Unique constraints (single column) ──
  const liveUnique = new Map(
    l.constraints.filter((c) => c.type === 'u' && c.columns.length === 1).map((c) => [c.columns[0], c]),
  );
  for (const c of t.columns) {
    const wanted = !!c.unique && !(wantPk.length === 1 && wantPk[0] === c.name);
    const lu = liveUnique.get(c.name);
    if (wanted && !lu) {
      add('addUnique', `ALTER TABLE ${T} ADD CONSTRAINT ${qi(uniqueName(name, c.name))} UNIQUE (${qi(c.name)})`, {
        kind: 'add_unique',
        table: name,
        column: c.name,
        detail: `Make "${c.name}" unique (fails on repeated values)`,
        safety: 'review',
      });
    } else if (!wanted && lu && snapCols.get(c.name)?.unique) {
      add('dropUnique', `ALTER TABLE ${T} DROP CONSTRAINT ${qi(lu.name)}`, {
        kind: 'drop_unique',
        table: name,
        column: c.name,
        detail: `Allow repeated values in "${c.name}"`,
        safety: 'safe',
      });
    }
  }

  // ── Foreign keys (single column) ──
  const liveFks = new Map(
    l.constraints.filter((c) => c.type === 'f' && c.columns.length === 1).map((c) => [c.columns[0], c]),
  );
  const snapFks = new Map((snap?.foreignKeys ?? []).map((f) => [f.column, f]));
  const wantFks = new Map((t.foreignKeys ?? []).map((f) => [f.column, f]));
  for (const [col, fk] of wantFks) {
    const lf = liveFks.get(col);
    const same = lf && lf.refTable === fk.refTable && sameList(lf.refColumns ?? [], [fk.refColumn]);
    if (same) continue;
    if (lf) {
      add('dropFk', `ALTER TABLE ${T} DROP CONSTRAINT ${qi(lf.name)}`, {
        kind: 'drop_foreign_key',
        table: name,
        column: col,
        detail: `Remove reference "${col}" → ${lf.refTable}.${(lf.refColumns ?? []).join(', ')}`,
        safety: 'safe',
      });
    }
    add('addFk', buildForeignKey(name, fk), {
      kind: 'add_foreign_key',
      table: name,
      column: col,
      detail: `Add reference "${col}" → ${fk.refTable}.${fk.refColumn} (fails if values have no match)`,
      safety: 'review',
    });
  }
  for (const [col, lf] of liveFks) {
    if (wantFks.has(col) || !snapFks.has(col) || !targetCols.has(col)) continue;
    add('dropFk', `ALTER TABLE ${T} DROP CONSTRAINT ${qi(lf.name)}`, {
      kind: 'drop_foreign_key',
      table: name,
      column: col,
      detail: `Remove reference "${col}" → ${lf.refTable}.${(lf.refColumns ?? []).join(', ')}`,
      safety: 'safe',
    });
  }
}

/**
 * Live schema equivalent to having generated `model` exactly — lets a pure
 * model-to-model diff run through the same planner.
 */
export function liveSchemaFromModel(model: DataModel): LiveSchema {
  const live: LiveSchema = new Map();
  for (const t of model.tables ?? []) {
    const generatedKey = hasGeneratedKey(t);
    const columns = [
      ...(generatedKey ? [{ name: 'id', dataType: 'uuid', nullable: false }] : []),
      ...t.columns.map((c) => ({
        name: c.name,
        dataType: Object.keys(LOGICAL_TYPE).find((k) => LOGICAL_TYPE[k] === c.type) ?? 'text',
        nullable: c.nullable,
      })),
      { name: 'created_at', dataType: 'timestamp with time zone', nullable: false },
      { name: 'updated_at', dataType: 'timestamp with time zone', nullable: false },
    ];
    const pk = generatedKey ? ['id'] : (t.primaryKey as string[]);
    live.set(t.name, {
      name: t.name,
      columns,
      constraints: [
        { name: pkName(t.name), type: 'p', columns: pk },
        ...t.columns
          .filter((c) => c.unique && !(pk.length === 1 && pk[0] === c.name))
          .map((c) => ({ name: uniqueName(t.name, c.name), type: 'u' as const, columns: [c.name] })),
        ...(t.foreignKeys ?? []).map((f) => ({
          name: fkName(t.name, f.column),
          type: 'f' as const,
          columns: [f.column],
          refTable: f.refTable,
          refColumns: [f.refColumn],
        })),
      ],
    });
  }
  return live;
}

/** Compute the schema diff from one data model to another. */
export function diffDataModels(from: DataModel, to: DataModel): MigrationPlan {
  return planSchemaChanges({ target: to, live: liveSchemaFromModel(from), snapshot: from });
}
