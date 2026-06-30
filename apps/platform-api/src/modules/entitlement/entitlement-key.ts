/**
 * Plan-scoped feature flags. A plan's `features` JSON may map any of these to
 * true/false; absent or true means allowed (default-allow, so existing plans
 * keep working until an operator explicitly disables a feature).
 */
export enum EntitlementKey {
  FLOWS = 'flows',
  STRUCTURE_ITEMS_READ = 'structure_items_read',
  STRUCTURE_ITEMS_WRITE = 'structure_items_write',
  EXTERNAL_DB_ACCESS = 'external_db_access',
  MIGRATION_ASSESSMENT = 'migration_assessment',
  SCHEMA_MIGRATIONS = 'schema_migrations',
}
