export interface Field {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey?: boolean;
  foreignKey?: string;
  description?: string;
}

export interface Table {
  name: string;
  displayName: string;
  fields: Field[];
}

export interface NavItem {
  label: string;
  table: string;
  icon?: string;
}

export interface Page {
  type: 'list' | 'form' | 'detail' | 'dashboard';
  table: string;
  label: string;
  search?: boolean;
  widgets?: string[];
}

export interface ApplicationModel {
  name: string;
  navigation: NavItem[];
  roles: Array<{ name: string; permissions: Record<string, string[]> }>;
}

export interface DataModel {
  tables: Table[];
}

export interface UIModel {
  pages: Page[];
}

export interface BuildPackage {
  version: number;
  projectId: string;
  blueprintId?: string;
  generatedAt: string;
  dataModel: DataModel;
  applicationModel: ApplicationModel;
  uiModel: UIModel;
}

export interface KPIWidget {
  label: string;
  table: string;
  aggregate: 'count' | 'sum' | 'avg';
  field?: string;
  value?: number | string; // populated at render time
}

export interface DashboardConfig {
  kpis: KPIWidget[];
  recentTables: string[]; // show last 5 rows of each
}
