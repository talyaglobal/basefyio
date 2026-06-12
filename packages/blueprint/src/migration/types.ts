export type ChangeType =
  | 'field_added'
  | 'field_removed'
  | 'field_renamed'
  | 'field_type_changed'
  | 'collection_added'
  | 'collection_removed'
  | 'index_added'
  | 'index_removed'
  | 'constraint_changed';

export type SafetyLevel = 'SAFE' | 'DESTRUCTIVE' | 'POTENTIALLY_SAFE';

export interface MigrationOperation {
  type: ChangeType;
  safety: SafetyLevel;
  collection: string;
  field?: string;
  fromField?: string;
  toField?: string;
  fromType?: string;
  toType?: string;
  detail: string;
}

export interface MigrationPlan {
  operations: MigrationOperation[];
  warnings: string[];
  breakingChanges: string[];
  hasDestructive: boolean;
}
