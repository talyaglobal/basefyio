import { DataModel, DataModelSchema, Field, Table } from '../schemas/data-model.schema.js';

interface RawSheet {
  sheet: string;
  headers: string[];
  sampleRows: unknown[][];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?|^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no', '1', '0']);

/**
 * Infer a field type from up to 20 sample cell values.
 * Majority-vote: picks the type that matches most non-null cells.
 */
export function inferFieldType(cells: unknown[]): Field['type'] {
  const samples = cells.filter((c) => c !== null && c !== undefined && c !== '').slice(0, 20);
  if (samples.length === 0) return 'string';

  const counts: Record<string, number> = {
    uuid: 0, boolean: 0, number: 0, date: 0, text: 0, string: 0,
  };

  for (const cell of samples) {
    const s = String(cell).trim();
    if (UUID_RE.test(s)) { counts.uuid++; continue; }
    if (BOOL_VALUES.has(s.toLowerCase())) { counts.boolean++; continue; }
    if (!isNaN(Number(s)) && s.length > 0) { counts.number++; continue; }
    if (DATE_RE.test(s)) { counts.date++; continue; }
    if (s.length > 255) { counts.text++; continue; }
    counts.string++;
  }

  // Pick the type with the highest count
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as Field['type'];
}

/**
 * Detect FK candidates: column name ends with _id or Id and refers to a known table.
 * Returns the referenced table name or undefined.
 */
export function detectForeignKey(
  fieldName: string,
  knownTableNames: string[],
): string | undefined {
  const lower = fieldName.toLowerCase();
  if (!lower.endsWith('_id') && !lower.endsWith('id')) return undefined;

  // Strip '_id' suffix to get the potential table name
  const base = lower.endsWith('_id')
    ? lower.slice(0, -3)
    : lower.slice(0, -2);

  // Match exact base name, or plural form (base + 's'), or base is plural of table name
  return knownTableNames.find((t) => {
    const tl = t.toLowerCase();
    return tl === base || tl === base + 's' || tl === base + 'es' || base === tl + 's' || base === tl + 'es';
  });
}

/**
 * Infer a DataModel from raw sheet data.
 * - One table per sheet (name = snake_case of sheet name)
 * - Types inferred from sample rows (majority vote over first 20 cells)
 * - FK candidates detected from column names ending in _id
 */
export function inferDataModel(sheets: RawSheet[]): DataModel {
  // First pass: build table names so FK detection can reference them
  const tableNames = sheets.map((s) => toSnakeCase(s.sheet));

  const tables: Table[] = sheets.map((s, i) => {
    const tableName = tableNames[i];
    const fields: Field[] = s.headers.map((header, colIdx) => {
      const cells = s.sampleRows.map((row) => (row as unknown[])[colIdx]);
      const fieldName = toSnakeCase(header);
      const inferredType = inferFieldType(cells);
      const foreignKey = detectForeignKey(fieldName, tableNames.filter((t) => t !== tableName));

      return {
        name: fieldName,
        type: inferredType,
        nullable: true,
        unique: false,
        primaryKey: fieldName === 'id',
        foreignKey,
        description: header,
      };
    });

    return {
      name: tableName,
      displayName: s.sheet,
      fields,
      description: '',
      sourceSheet: s.sheet,
    };
  });

  return DataModelSchema.parse({ tables, version: 1 });
}

function toSnakeCase(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}
