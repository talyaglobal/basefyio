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

export interface DataModel {
  tables: DataModelTable[];
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
