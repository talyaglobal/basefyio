import { InferredColumn } from '../data-import/lib/type-inferrer';

/** One sheet of raw tabular input (already parsed by the client). */
export interface BlueprintSheet {
  name: string;
  headers: string[];
  rows: unknown[][];
}

export interface AnalyzeBlueprintInput {
  teamId: string;
  name?: string;
  projectId?: string;
  sheets: BlueprintSheet[];
  /** sheet names to ignore. */
  excludeSheets?: string[];
}

export interface DataModelTable {
  /** sanitized, Postgres-safe table name. */
  name: string;
  /** original sheet name, for display. */
  label: string;
  columns: InferredColumn[];
}

/** A detected link: `fromTable.fromColumn` holds values of `toTable.toColumn`. */
export interface DataModelRelation {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface DataModel {
  tables: DataModelTable[];
  /** Foreign keys found by column name (orders.customer_id -> customers.customer_id). */
  relations?: DataModelRelation[];
  /** Notes for the user, e.g. a source column renamed because it collides with a system column. */
  warnings?: string[];
}

export interface UpdateBlueprintInput {
  name?: string;
  /** Edited tables; replaces the inferred data model until the tables are being generated. */
  dataModel?: DataModel;
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
