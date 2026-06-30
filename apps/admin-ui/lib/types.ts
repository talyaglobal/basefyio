export interface GitHubIntegration {
  connected: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  repoUrl?: string;
  token?: string;
}

export interface VercelIntegration {
  connected: boolean;
  projectId?: string;
  projectName?: string;
  projectUrl?: string;
  dashboardUrl?: string;
  token?: string;
  teamId?: string;
}

export interface TeamGitHubStatus {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
  oauthConfigured: boolean;
}

export interface TeamVercelStatus {
  connected: boolean;
  user?: string;
  teamId?: string;
  oauthConfigured: boolean;
}

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  authorAvatar: string | null;
  date: string;
  url: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  description: string | null;
  updated_at: string;
}

export interface GitHubBranch {
  name: string;
  protected: boolean;
}

export interface VercelProject {
  id: string;
  name: string;
  framework: string | null;
  url: string | null;
  updatedAt: number;
}

export interface VercelDeployment {
  id: string;
  state: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
  url: string | null;
  commitMessage: string | null;
  branch: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  teamId: string;
  folderId: string | null;
  folder?: { id: string; name: string; color: string } | null;
  tags?: { tag: { id: string; name: string; color: string } }[];
  dbName: string;
  dbHost: string;
  dbPort: number;
  keycloakRealm: string;
  anonKey: string;
  serviceKey: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  /** Database model chosen in the New Project wizard. */
  databaseType?: 'RELATIONAL' | 'NOSQL';
  /** Max rows the Data grid loads per table (plan-gated: 1000 / 10000 / 100000). */
  maxRowsPerTable?: number;
  createdAt: string;
  updatedAt: string;
  importSource?: 'MANUAL' | 'SUPABASE' | 'ZIP';
  /** Persisted summary from the last completed Supabase import (if any). */
  supabaseImportLog?: unknown;
  github?: GitHubIntegration;
  vercel?: VercelIntegration;
  pgvectorEnabled?: boolean;
  pgvectorEnabledAt?: string | null;
}

/** Single row from `GET /projects/:id/activity` */
export interface ProjectActivityItem {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  metadata: unknown;
  createdAt: string;
  userId: string | null;
  actorName?: string;
}

export interface ProjectFolder {
  id: string;
  name: string;
  color: string;
  teamId: string;
  createdAt: string;
  _count?: { projects: number };
}

export interface ProjectTag {
  id: string;
  name: string;
  color: string;
  teamId: string;
  createdAt: string;
  _count?: { assignments: number };
}

export interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  /** Database model chosen in the New Project wizard. */
  databaseType?: 'RELATIONAL' | 'NOSQL';
  folderId: string | null;
  folder?: { id: string; name: string; color: string } | null;
  tags?: { tag: { id: string; name: string; color: string } }[];
  createdBy?: string | null;
  createdByName?: string | null;
  projectSizeBytes?: number | null;
  createdAt: string;
  updatedAt: string;
  /** Set when status is DELETED; used for 24h trash retention. */
  deletedAt?: string | null;
  /** Team id/name — populated by the all-teams trash listing. */
  teamId?: string;
  teamName?: string | null;
  /** Trash only: whether this user may restore / permanently delete it. */
  canManage?: boolean;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  memberCount: number;
  projectCount: number;
}

export interface TeamMember {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  organization?: string;
  invitedBy: string;
  invitedByFullName?: string | null;
  invitedByEmail?: string | null;
  invitedEmail?: string | null;
  createdAt: string;
  expiresAt?: string;
}

export interface PendingInvite {
  id: string;
  invitedEmail?: string | null;
  invitedUser: { id: string | null; email: string | null };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresIn: number;
  tokenType?: string;
  hasPendingInvites?: boolean;
  forcePasswordChange?: boolean;
}

export interface UserInfo {
  sub: string;
  email: string;
  preferred_username: string;
  roles: string[];
}

export interface UserProfile {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  githubUsername: string | null;
  notifySignIn: boolean;
  notifySignInNewDevice: boolean;
  notifyTeamInvite: boolean;
  notifyBrowserPush: boolean;
  role: string;
  createdAt: string;
  authProvider?: 'local' | 'google' | 'github';
  signOnMethod?: 'local' | 'google' | 'github';
  canEditIdentityFields?: boolean;
  canChangePassword?: boolean;
  forcePasswordChange?: boolean;
}

export interface ManagementUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: 'USER' | 'ADMIN' | 'ROOT';
  isActive?: boolean;
  authProvider?: 'local' | 'google' | 'github';
  signOnMethod?: 'local' | 'google' | 'github';
  linkedProviders?: Array<'google' | 'github'>;
  hasPasswordAuth?: boolean;
  /** Failed-login lockout expiry; account is locked while this is in the future. */
  lockedUntil?: string | null;
  createdAt: string;
  _count: { teamMembers: number };
}

export interface ManagementUsersPageResponse {
  users: ManagementUser[];
  total: number;
}

export interface RolePermissionMatrix {
  role: 'USER' | 'ADMIN' | 'ROOT';
  canAccessManagement: boolean;
  canManageUsers: boolean;
  canManageTeams: boolean;
  canManagePlans: boolean;
  canManageUserPackages: boolean;
  canModerateFeedback: boolean;
  canViewAuditLogs: boolean;
  canViewRootAlerts: boolean;
}

export interface ManagementTeam {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  memberCount: number;
  projectCount: number;
  owner: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  } | null;
}

export interface ManagementPlan {
  id: string;
  name: string;
  displayName: string;
  priceMonthly: number;
  maxProjects: number | null;
  maxStorageBytes: string | number | null;
  maxTeamMembers: number | null;
  maxDbSizeBytes: string | number | null;
  maxApiRequests: number | null;
  maxBandwidthBytes: string | number | null;
  maxMau: number | null;
  isPublic: boolean;
}

export interface ManagementUserPackage {
  userId: string;
  email: string;
  teamId: string | null;
  teamName: string | null;
  planName: string | null;
  planDisplayName: string | null;
  planPriceMonthly: number | null;
  subscriptionStatus: string | null;
}

export interface ManagementGscSitemapRow {
  path: string;
  type?: string;
  lastSubmitted?: string | null;
  lastDownloaded?: string | null;
  isPending?: boolean;
  warnings: number;
  errors: number;
}

export interface GscSearchPerformanceRow {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscDimensionRow {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  [key: string]: string | number;
}

export interface GscSearchPerformance {
  from: string;
  to: string;
  totals: { clicks: number; impressions: number; ctr: number; avgPosition: number };
  byDate: GscSearchPerformanceRow[];
  topQueries: (GscDimensionRow & { query: string })[];
  topPages: (GscDimensionRow & { page: string })[];
  byDevice: (GscDimensionRow & { device: string })[];
  byCountry: (GscDimensionRow & { country: string })[];
}

export type ManagementSearchConsoleSummary =
  | { configured: false; message?: string }
  | {
      configured: true;
      siteUrl: string;
      sites: { siteUrl: string; permissionLevel: string }[];
      sitemaps: ManagementGscSitemapRow[];
      urlInspection: Record<string, unknown> | null;
      searchPerformance: GscSearchPerformance | null;
      error?: string;
    };

export type ManagementAnalyticsTrafficSummary =
  | { configured: false; message?: string }
  | {
      configured: true;
      propertyId: string;
      byDate: Record<string, number | string>[];
      dimensionHeaders: string[];
      metricHeaders: string[];
      summary: Record<string, number>;
      topPages?: Record<string, number | string>[];
      trafficSources?: Record<string, number | string>[];
      byDevice?: Record<string, number | string>[];
      byCountry?: Record<string, number | string>[];
      error?: string;
    };

export interface RootAlert {
  id: string;
  kind: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | string;
  title: string;
  message: string;
  relatedAuditLogId: string | null;
  isRead: boolean;
  createdAt: string;
  /** Resolved from related audit: who performed the action */
  relatedActorDisplay?: string | null;
  /** Resolved from related audit: primary resource (e.g. affected user) */
  relatedTargetDisplay?: string | null;
}

export interface AuditLogEntry {
  id: string;
  traceId: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  severity: string;
  success: boolean;
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  metadataJson: Record<string, unknown> | null;
  createdAt: string;
  /** Resolved user label for actorUserId */
  actorDisplayName?: string | null;
  /** Resolved label when resource is a user (or other known types later) */
  resourceDisplayName?: string | null;
}

export interface ProjectDeletionReasonEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorName?: string | null;
  projectId: string;
  projectName: string | null;
  teamId?: string | null;
  teamName?: string | null;
  reasonCode: string | null;
  reasonLabel: string | null;
  details: string | null;
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeId: number }[];
  rowCount: number;
  duration: number;
  /** Pagination metadata (only meaningful when `paginated` is true). */
  page?: number;
  limit?: number;
  paginated?: boolean;
  /** Bounded count of total rows; null when not requested or query failed. */
  total?: number | null;
  /** True when total was capped at 10k. */
  totalIsApprox?: boolean;
  /** One entry per statement in a multi-statement script (in execution order). */
  resultSets?: {
    fields?: { name: string; dataTypeId: number }[];
    rows?: Record<string, unknown>[];
    rowCount: number | null;
  }[];
}

export interface ApiError {
  statusCode: number;
  message: string;
  timestamp: string;
}

export interface TableInfo {
  name: string;
  schema: string;
  rowCount: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimary: boolean;
}

export interface ForeignKeyInfo {
  constraintName: string;
  columnName: string;
  foreignTableName: string;
  foreignColumnName: string;
}

export interface TableRows {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeId: number }[];
  total: number;
  /** When searching, total is capped at 10k; this flag tells the UI to render "10.000+". */
  totalIsApprox?: boolean;
  page: number;
  limit: number;
  totalPages: number;
}

// ── NoSQL / Collections ────────────────────────────────────

export interface CollectionInfo {
  name: string;
  documentCount: number;
}

export interface DocumentRecord {
  id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DocumentListResult {
  data: DocumentRecord[];
  total: number;
  limit: number;
  offset: number;
}

// ── Data Engine ──────────────────────────────────────────

export interface EntityDefinitionInfo {
  id: string;
  logicalName: string;
  displayName: string;
  physicalCollection: string;
  storageStrategy: string;
  schemaVersion: number;
  fields: unknown[];
  rules: unknown[];
  generatedByAI: boolean;
  description?: string;
  icon?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataEngineDoc {
  _id: string;
  _entity: string;
  _projectId: string;
  _schemaVersion: number;
  _version: number;
  _eventSequence: number;
  _status: string;
  _createdAt: string;
  _updatedAt: string;
  _createdBy: string;
  _deletedAt: string | null;
  [key: string]: unknown;
}

export interface DataEnginePage {
  data: DataEngineDoc[];
  total: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface DataEngineHealth {
  available: boolean;
  reachable: boolean;
}

// ── Data Query (provider-aware query editor) ──────────────

export interface DataQueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeId: number }[];
  rowCount: number;
  duration: number;
  page: number;
  limit: number;
  paginated: boolean;
  total: number | null;
  totalIsApprox?: boolean;
  target: 'entity' | 'collection';
  entity: string;
  action: 'find' | 'count' | 'aggregate';
}

export interface DataQueryCapabilities {
  engineAvailable: boolean;
  queryModes: ('js' | 'aggregation')[];
  capabilities: {
    transactions: boolean;
    fullTextSearch: boolean;
    vectorSearch: boolean;
    ttl: boolean;
    aggregationPipeline: boolean;
  } | null;
}

export interface SavedDataQueryItem {
  id: string;
  name: string;
  mode: string;
  entity: string | null;
  source: string;
  createdAt: string;
}

export interface RealmUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  createdTimestamp: number;
}

export interface RealmSession {
  id: string;
  ipAddress: string | null;
  start: number | null;
  lastAccess: number | null;
  clients: string[];
  location?: string | null;
}

export interface RealmSessionFull extends RealmSession {
  userId: string | null;
  username: string | null;
}

export interface RealmUserDetail {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  createdTimestamp: number;
  providers: string[];
  sessions: RealmSession[];
  sessionCount: number;
  lastSignIn: number | null;
}

export interface MfaFactor {
  id: string;
  type: string;
  userLabel: string | null;
  createdDate: number | null;
}

export interface MfaUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  factors: MfaFactor[];
}

export interface RealmPolicies {
  bruteForceProtected: boolean;
  permanentLockout: boolean;
  failureFactor: number;
  waitIncrementSeconds: number;
  maxFailureWaitSeconds: number;
  passwordPolicy: string;
  password: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireDigits: boolean;
    requireSpecial: boolean;
    historyCount: number;
    expiryDays: number;
  };
}

export interface RealmInfo {
  name: string;
  enabled: boolean;
  userCount: number;
  clientCount: number;
  registrationAllowed: boolean;
  loginWithEmailAllowed: boolean;
}

export interface ProjectAuthConfig {
  allowSignup: boolean;
  requireEmailVerify: boolean;
  minPasswordLength: number;
  tokenExpirySeconds: number;
  emailProvider: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpPass: string | null;
  senderEmail: string | null;
  senderName: string | null;
  resendApiKey: string | null;
  sendgridApiKey: string | null;
  sesAccessKey: string | null;
  sesSecretKey: string | null;
  sesRegion: string | null;
  verifyEmailSubject: string | null;
  verifyEmailBody: string | null;
  resetPasswordSubject: string | null;
  resetPasswordBody: string | null;
  welcomeSubject: string | null;
  welcomeBody: string | null;
  inviteUserSubject: string | null;
  inviteUserBody: string | null;
  magicLinkSubject: string | null;
  magicLinkBody: string | null;
  changeEmailSubject: string | null;
  changeEmailBody: string | null;
  reauthSubject: string | null;
  reauthBody: string | null;
  googleEnabled: boolean;
  googleClientId: string | null;
  googleClientSecret: string | null;
  githubEnabled: boolean;
  githubClientId: string | null;
  githubClientSecret: string | null;
  microsoftEnabled: boolean;
  microsoftClientId: string | null;
  microsoftClientSecret: string | null;
  appleEnabled: boolean;
  appleClientId: string | null;
  appleClientSecret: string | null;
  gitlabEnabled: boolean;
  gitlabClientId: string | null;
  gitlabClientSecret: string | null;
  linkedinEnabled: boolean;
  linkedinClientId: string | null;
  linkedinClientSecret: string | null;
  facebookEnabled: boolean;
  facebookClientId: string | null;
  facebookClientSecret: string | null;
  twitterEnabled: boolean;
  twitterClientId: string | null;
  twitterClientSecret: string | null;
}

export interface ConnectionStrings {
  uri: string;
  poolerUri: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolerHost: string;
  poolerPort: number;
  restUrl: string;
  publicBaseUrl: string;
  keycloakRealm: string;
  keycloakUrl: string;
  anonKey: string;
  serviceKey: string;
  canResetDbPassword?: boolean;
}

export interface StorageBucket {
  id: string;
  name: string;
  public: boolean;
  createdAt: string;
  objectCount: number;
  totalSize: number;
}

export interface StorageObject {
  name: string;
  prefix?: string;
  size: number;
  lastModified: string;
  etag?: string;
}

export interface SupabaseImportRequest {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Rare fallback: direct Postgres copy if PostgREST still cannot read a table */
  databasePassword?: string;
  name: string;
  teamId: string;
  /** When set, import runs into this existing basefyio project (same DB/realm). */
  existingProjectId?: string;
}

export interface SupabaseImportJobResponse {
  jobId: string;
  project: {
    id: string;
    name: string;
    slug: string;
  };
  /** True when import targeted an existing project (re-import). */
  reimport?: boolean;
}

export interface ProjectExportRequest {
  includeDatabase?: boolean;
  includeAuth?: boolean;
  includeStorage?: boolean;
  includeConfig?: boolean;
}

export interface ProjectExportJobResponse {
  jobId: string;
}

export interface ProjectArchiveImportResponse {
  project: {
    id: string;
    name: string;
    slug: string;
  };
  importedName: string;
  appliedName: string;
  warnings: string[];
}

export interface CloudBackupItem {
  objectKey: string;
  filename: string;
  size: number;
  lastModified: string;
  /** auto = scheduled daily backup (7-day retention); manual = user export (24h). */
  kind?: 'manual' | 'auto';
}

export interface ImportProgressData {
  database: { tables: number; rows: number; failedTables: string[] };
  auth: { users: number; skipped: number; emailsSent: number };
  storage: { buckets: number; objects: number };
  warnings: string[];
}

/** Ensures SSE/job payloads always yield full lists for the result UI. */
export function normalizeImportProgressData(
  raw: Partial<ImportProgressData> | null | undefined,
): ImportProgressData {
  return {
    database: {
      tables: raw?.database?.tables ?? 0,
      rows: raw?.database?.rows ?? 0,
      failedTables: Array.isArray(raw?.database?.failedTables)
        ? raw.database.failedTables
        : [],
    },
    auth: {
      users: raw?.auth?.users ?? 0,
      skipped: raw?.auth?.skipped ?? 0,
      emailsSent: raw?.auth?.emailsSent ?? 0,
    },
    storage: {
      buckets: raw?.storage?.buckets ?? 0,
      objects: raw?.storage?.objects ?? 0,
    },
    warnings: Array.isArray(raw?.warnings) ? raw.warnings : [],
  };
}

export type ProjectSupabaseImportLog = ImportProgressData & {
  completedAt?: string;
};

export function parseProjectSupabaseImportLog(
  raw: unknown,
): ProjectSupabaseImportLog | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const base = normalizeImportProgressData(o as Partial<ImportProgressData>);
  const completedAt =
    typeof o.completedAt === 'string' ? o.completedAt : undefined;
  return { ...base, completedAt };
}

export interface ImportJobProgressEvent {
  step: 'database' | 'auth' | 'storage' | 'completed' | 'failed';
  detail: string;
  percent: number;
  progress?: ImportProgressData;
  error?: string;
  /** Active fetch strategy label (e.g. "PostgREST", "Direct SQL", "HTTP REST", "CSV") */
  strategy?: string;
}

export interface ExportJobResult {
  bucket: string;
  objectKey: string;
  filename: string;
  size: number;
}

export interface ExportJobProgressEvent {
  step:
    | 'database'
    | 'auth'
    | 'storage'
    | 'metadata'
    | 'packaging'
    | 'completed'
    | 'failed';
  detail: string;
  percent: number;
  error?: string;
}

export interface SupabaseValidateResult {
  valid: boolean;
  projectName: string;
  tableCount: number;
}
/* ─────────────────── Data Import wizard types ─────────────────── */

export type DataImportColumnType =
  | 'boolean'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'uuid'
  | 'date'
  | 'timestamptz'
  | 'jsonb'
  | 'text';

export interface DataImportInferredColumn {
  name: string;
  originalName: string;
  type: DataImportColumnType;
  nullable: boolean;
  sampleValues: string[];
}

export interface DataImportInspectResult {
  sourceKey: string;
  filename: string;
  format: 'csv' | 'xlsx';
  totalRowsApprox: number;
  headers: string[];
  inferredColumns: DataImportInferredColumn[];
  sampleRows: unknown[][];
  existingTables: Array<{ schema: string; name: string }>;
  /** Echo of the firstRowIsHeader flag the inspect used. UI surfaces it as a
   *  checkbox; toggling re-runs inspect. */
  firstRowIsHeader: boolean;
}

export interface DataImportColumnMapping {
  source: string;
  target: string;
  type: DataImportColumnType;
  nullable?: boolean;
}

export interface DataImportPlan {
  sourceKey: string;
  /** Extra staged source keys when the user uploaded multiple files in one
   *  wizard session. All files share the schema from `sourceKey`. */
  additionalSourceKeys?: string[];
  filename: string;
  format: 'csv' | 'xlsx';
  firstRowIsHeader?: boolean;
  targetMode: 'existing' | 'new';
  tableName: string;
  schemaName?: string;
  conflictMode: 'skip' | 'update' | 'fail';
  conflictColumns?: string[];
  columns: DataImportColumnMapping[];
}

export interface DataImportProgress {
  step: 'parse' | 'insert' | 'done';
  detail: string;
  rowsRead?: number;
  rowsInserted?: number;
  rowsSkipped?: number;
  rowsBad?: number;
  percent?: number;
}

export interface DataImportResult {
  rowsRead: number;
  rowsInserted: number;
  rowsSkippedConflict: number;
  rowsBad: number;
  errorKey?: string;
  durationMs: number;
}

export interface DataImportJobStatus {
  id: string;
  state: string;
  progress: DataImportProgress | Record<string, unknown> | number | null;
  result?: DataImportResult;
  failedReason?: string;
}


// ── Flows (project automation) ───────────────────────────────────────────────
export type FlowTriggerType = 'manual' | 'webhook' | 'schedule';
export type FlowActionType = 'log' | 'http.request';

export interface FlowTrigger {
  type: FlowTriggerType;
  webhookPath?: string;
  cron?: string;
}

export interface FlowAction {
  type: FlowActionType;
  message?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  continueOnError?: boolean;
}

export interface FlowInput {
  name: string;
  trigger: FlowTrigger;
  actions: FlowAction[];
  enabled?: boolean;
}

export interface Flow {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: FlowTrigger;
  actions: FlowAction[];
  createdAt: string;
  updatedAt: string;
}

export interface FlowRun {
  id: string;
  flowId: string;
  projectId: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  input?: unknown;
  result?: unknown;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
}

// ── Blueprint (Excel → App) ──────────────────────────────────────────────────
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
  excludeSheets?: string[];
}

export interface InferredColumn {
  name: string;
  originalName: string;
  type: string;
  nullable: boolean;
  sampleValues: string[];
}

export interface DataModelTable {
  name: string;
  label: string;
  columns: InferredColumn[];
}

export interface DataModel {
  tables: DataModelTable[];
}

export interface AppRole {
  name: string;
  permissions: Record<string, string[]>;
}

export interface ApplicationModel {
  name: string;
  roles: AppRole[];
  navigation: Array<{ label: string; table: string }>;
  tables: string[];
}

export type BlueprintStatus = 'DRAFT' | 'APPROVED' | 'GENERATING' | 'GENERATED' | 'FAILED';

export interface BlueprintSummary {
  id: string;
  name: string;
  status: BlueprintStatus;
  domain: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationVersion {
  id: string;
  version: number;
  changeSummary: string | null;
  createdAt: string;
}

export interface BlueprintDetail extends BlueprintSummary {
  teamId: string;
  dataModel: DataModel;
  businessModel: { domain: string; actors: string[]; objects: string[]; kpis: string[] } | null;
  applicationModel: ApplicationModel | null;
  versions?: ApplicationVersion[];
}

export interface BlueprintGenerateResult {
  status: string;
  projectId: string;
  created: number;
  skipped: number;
  tables: Array<{ table: string; created: boolean; reason?: string }>;
}

// ── Schema migrations ────────────────────────────────────────────────────────
export type MigrationChangeKind =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column_type';

export type MigrationSafety = 'safe' | 'review' | 'destructive';

export interface MigrationChange {
  kind: MigrationChangeKind;
  table: string;
  column?: string;
  detail: string;
  safety: MigrationSafety;
}

export interface MigrationPlan {
  changes: MigrationChange[];
  statements: string[];
  newTables: unknown[];
  hasDestructive: boolean;
}

export interface MigrationRun {
  id: string;
  blueprintId: string;
  projectId: string;
  status: 'PENDING' | 'APPLIED' | 'FAILED';
  plan: MigrationPlan;
  appliedCount: number;
  error?: string | null;
  createdAt: string;
  appliedAt?: string | null;
}
