import type { DataModel, MigrationOperation, MigrationPlan, Table } from '@basefyio/blueprint';

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

function pgType(type: string): string {
  switch (type) {
    case 'number': return 'numeric';
    case 'boolean': return 'boolean';
    case 'date': return 'timestamptz';
    case 'uuid': return 'uuid';
    case 'text':
    case 'string':
    default: return 'text';
  }
}

function tableByName(model: DataModel, name: string): Table | undefined {
  return model.tables.find(t => t.name === name);
}

function sqlForOperation(op: MigrationOperation, v1: DataModel, v2: DataModel): string[] {
  const t = quoteIdent(op.collection);

  switch (op.type) {
    case 'collection_added': {
      const table = tableByName(v2, op.collection);
      if (!table) return [];
      const cols: string[] = [`  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid()`];
      for (const f of table.fields) {
        if (f.name === 'id') continue;
        const colType = f.foreignKey ? 'UUID' : pgType(f.type);
        const notNull = !f.nullable ? ' NOT NULL' : '';
        const unique = f.unique ? ' UNIQUE' : '';
        const fk = f.foreignKey
          ? ` REFERENCES ${quoteIdent(f.foreignKey)}(id) ON DELETE SET NULL`
          : '';
        cols.push(`  ${quoteIdent(f.name)} ${colType}${notNull}${unique}${fk}`);
      }
      cols.push(`  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
      cols.push(`  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
      return [`CREATE TABLE IF NOT EXISTS ${t} (\n${cols.join(',\n')}\n);`];
    }

    case 'collection_removed':
      return [`DROP TABLE IF EXISTS ${t};`];

    case 'field_added': {
      const field = tableByName(v2, op.collection)?.fields.find(f => f.name === op.field);
      if (!field) return [];
      const colType = field.foreignKey ? 'UUID' : pgType(field.type);
      const notNull = !field.nullable ? ' NOT NULL' : '';
      const unique = field.unique ? ' UNIQUE' : '';
      const fk = field.foreignKey
        ? ` REFERENCES ${quoteIdent(field.foreignKey)}(id) ON DELETE SET NULL`
        : '';
      return [
        `ALTER TABLE ${t} ADD COLUMN ${quoteIdent(field.name)} ${colType}${notNull}${unique}${fk};`,
      ];
    }

    case 'field_removed':
      return [`ALTER TABLE ${t} DROP COLUMN IF EXISTS ${quoteIdent(op.field!)};`];

    case 'field_renamed':
      return [
        `ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(op.fromField!)} TO ${quoteIdent(op.toField!)};`,
      ];

    case 'field_type_changed': {
      const col = quoteIdent(op.field!);
      const newPgType = pgType(op.toType!);
      return [
        `ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${newPgType} USING ${col}::${newPgType};`,
      ];
    }

    case 'index_added': {
      const idxName = quoteIdent(`${op.collection}_${op.field!}_unique`);
      return [
        `CREATE UNIQUE INDEX IF NOT EXISTS ${idxName} ON ${t} (${quoteIdent(op.field!)});`,
      ];
    }

    case 'index_removed': {
      const idxName = quoteIdent(`${op.collection}_${op.field!}_unique`);
      return [`DROP INDEX IF EXISTS ${idxName};`];
    }

    case 'constraint_changed': {
      const col = quoteIdent(op.field!);
      const v2Field = tableByName(v2, op.collection)?.fields.find(f => f.name === op.field);
      if (!v2Field) return [];
      if (!v2Field.nullable) {
        return [`ALTER TABLE ${t} ALTER COLUMN ${col} SET NOT NULL;`];
      } else {
        return [`ALTER TABLE ${t} ALTER COLUMN ${col} DROP NOT NULL;`];
      }
    }

    default:
      return [];
  }
}

/**
 * Generate ordered SQL statements from a MigrationPlan.
 * SAFE operations come first, POTENTIALLY_SAFE second, DESTRUCTIVE last.
 * Each statement is wrapped in a comment showing the operation type + detail.
 */
export function generateMigrationSQL(
  plan: MigrationPlan,
  v1: DataModel,
  v2: DataModel,
): string[] {
  const order: Record<string, number> = { SAFE: 0, POTENTIALLY_SAFE: 1, DESTRUCTIVE: 2 };
  const sorted = [...plan.operations].sort(
    (a, b) => order[a.safety] - order[b.safety],
  );

  const statements: string[] = [];
  for (const op of sorted) {
    const sqls = sqlForOperation(op, v1, v2);
    for (const sql of sqls) {
      statements.push(`-- [${op.safety}] ${op.detail}\n${sql}`);
    }
  }
  return statements;
}
