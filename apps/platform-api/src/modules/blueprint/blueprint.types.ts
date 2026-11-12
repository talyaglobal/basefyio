import { InferredColumn, ValueFormat } from '../data-import/lib/type-inferrer';

/** One sheet of raw tabular input (already parsed by the client). */
export interface BlueprintSheet {
  name: string;
  headers: string[];
  rows: unknown[][];
  /**
   * Data rows the sheet really has, when the client sent only part of them
   * (files too large for one request). Used to warn that loading is partial.
   */
  totalRows?: number;
}

export interface AnalyzeBlueprintInput {
  teamId: string;
  name?: string;
  projectId?: string;
  sheets: BlueprintSheet[];
  /** sheet names to ignore. */
  excludeSheets?: string[];
}

/** A data-model column: an inferred column plus the constraints the draft sets. */
export interface BlueprintColumn extends InferredColumn {
  /** UNIQUE constraint on this single column. */
  unique?: boolean;
  /**
   * Index of the source header this column reads from, so data can be loaded
   * after the column is renamed. Absent for columns added in the editor.
   */
  sourceIndex?: number;
}

export interface BlueprintForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface DataModelTable {
  /** sanitized, Postgres-safe table name. */
  name: string;
  /** original sheet name, for display. */
  label: string;
  columns: BlueprintColumn[];
  /**
   * Natural primary key (column names). Absent or empty means the table gets
   * a generated `id uuid` key.
   */
  primaryKey?: string[];
  foreignKeys?: BlueprintForeignKey[];
  /** How the source writes numbers and dates (detected per sheet). */
  valueFormat?: Pick<ValueFormat, 'decimalSeparator' | 'dateOrder'>;
  /** Data rows in the source sheet. */
  rowCount?: number;
}

/** Something the analyzer changed or could not do, shown on the draft. */
export interface BlueprintWarning {
  table: string;
  column?: string;
  code:
    | 'reserved_column_renamed'
    | 'duplicate_key_values'
    | 'reference_unmatched'
    | 'reference_type_mismatch'
    | 'rows_truncated'
    | 'table_renamed';
  message: string;
}

/**
 * Row-level security set up on generated tables.
 *   - service_role: only the service role (and the dashboard) can read/write.
 *   - authenticated_read: signed-in users can read every row.
 *   - authenticated_write: signed-in users can read and write every row.
 */
export type BlueprintAccess = 'service_role' | 'authenticated_read' | 'authenticated_write';

export const BLUEPRINT_ACCESS_MODES: readonly BlueprintAccess[] = [
  'service_role',
  'authenticated_read',
  'authenticated_write',
];

/** Data models from before keys, references and source mapping existed have no version. */
export const DATA_MODEL_VERSION = 2;

export interface DataModel {
  version?: number;
  tables: DataModelTable[];
  warnings?: BlueprintWarning[];
  /** Snapshot only: the access mode the tables were generated with. */
  access?: BlueprintAccess;
}

/** The stored source rows of one data-model table (see BlueprintSource). */
export interface BlueprintSourceSheet {
  /** data-model table name at analyze/sync time. */
  table: string;
  /** original sheet name; matches DataModelTable.label. */
  sheet: string;
  headers: string[];
  rows: unknown[][];
}

export type BlueprintDomain = 'crm' | 'inventory' | 'orders' | 'hr' | 'generic';

export interface BusinessModel {
  domain: BlueprintDomain;
  actors: string[];
  objects: string[];
  kpis: string[];
}

export interface AppRole {
  name: string;
  /** entity -> allowed operations. */
  permissions: Record<string, Array<'read' | 'create' | 'update' | 'delete'>>;
}

export interface AppNavItem {
  label: string;
  table: string;
}

export interface ApplicationModel {
  name: string;
  roles: AppRole[];
  navigation: AppNavItem[];
  tables: string[];
}
