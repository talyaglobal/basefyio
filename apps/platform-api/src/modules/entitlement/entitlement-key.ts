export enum EntitlementKey {
  MIGRATION_ARCHIVE_CREATE  = 'migrationArchiveCreate',
  MIGRATION_ARCHIVE_READ    = 'migrationArchiveRead',
  MIGRATION_ASSESSMENT_RUN  = 'migrationAssessmentRun',
  MIGRATION_ASSESSMENT_READ = 'migrationAssessmentRead',
  EXTERNAL_DB_ACCESS        = 'externalDbAccess',
  CUSTOM_DOMAIN             = 'customDomain',
  DEDICATED_ENDPOINT        = 'dedicatedEndpoint',
  CERT_DOWNLOAD             = 'certDownload',
  GATEWAY_CONNECT           = 'gatewayConnect',
  GATEWAY_QUERY             = 'gatewayQuery',
}

/** Keys that grant read-only archive/assessment access when present in Plan.features. */
export const MIGRATION_READ_KEYS = [
  EntitlementKey.MIGRATION_ARCHIVE_READ,
  EntitlementKey.MIGRATION_ASSESSMENT_READ,
] as const;
