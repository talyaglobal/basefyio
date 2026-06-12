interface FieldDef {
  name: string;
  type: string;       // from DataModel field type
  nullable: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  foreignKey?: string; // referenced table name
}

interface TableDef {
  name: string;       // snake_case table name
  displayName: string;
  fields: FieldDef[];
}

/** Maps DataModel field types to Postgres DDL types */
function pgType(type: string): string {
  switch (type) {
    case 'number': return 'numeric';
    case 'boolean': return 'boolean';
    case 'date': return 'timestamptz';
    case 'uuid': return 'uuid';
    case 'text': return 'text';
    default: return 'text';
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

/**
 * Generate CREATE TABLE DDL for a single table.
 * Always adds id UUID PRIMARY KEY as first column (generated default).
 * Adds created_at + updated_at timestamps.
 * FK columns become UUID type with REFERENCES clause.
 */
export function generateTableDDL(table: TableDef): string {
  const lines: string[] = [];
  lines.push(`  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid()`);

  for (const f of table.fields) {
    if (f.name === 'id') continue; // already added
    const colType = f.foreignKey ? 'UUID' : pgType(f.type);
    const notNull = !f.nullable ? ' NOT NULL' : '';
    const unique = f.unique ? ' UNIQUE' : '';
    const fkRef = f.foreignKey ? ` REFERENCES ${quoteIdent(f.foreignKey)}(id) ON DELETE SET NULL` : '';
    lines.push(`  ${quoteIdent(f.name)} ${colType}${notNull}${unique}${fkRef}`);
  }

  lines.push(`  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);
  lines.push(`  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()`);

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n${lines.join(',\n')}\n);`;
}

/**
 * Generate full DDL for all tables in the data model.
 * Returns DDL strings in topological order (tables without FKs first).
 */
export function generateDDL(tables: TableDef[]): string[] {
  // Simple topo sort: tables with no outgoing FK fields first (they are the referenced roots)
  const hasOutgoingFk = new Set(
    tables
      .filter(t => t.fields.some(f => f.foreignKey))
      .map(t => t.name),
  );
  const sorted = [
    ...tables.filter(t => !hasOutgoingFk.has(t.name)),
    ...tables.filter(t => hasOutgoingFk.has(t.name)),
  ];
  return sorted.map(generateTableDDL);
}
