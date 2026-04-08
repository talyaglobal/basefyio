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
  dbName: string;
  dbHost: string;
  dbPort: number;
  keycloakRealm: string;
  anonKey: string;
  serviceKey: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  createdAt: string;
  updatedAt: string;
  importSource?: 'MANUAL' | 'SUPABASE' | 'ZIP';
  /** Persisted summary from the last completed Supabase import (if any). */
  supabaseImportLog?: unknown;
  github?: GitHubIntegration;
  vercel?: VercelIntegration;
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
  folderId: string | null;
  folder?: { id: string; name: string; color: string } | null;
  tags?: { tag: { id: string; name: string; color: string } }[];
  createdAt: string;
  updatedAt: string;
}

export interface Team {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  role: 'OWNER' | 'MEMBER';
  memberCount: number;
  projectCount: number;
}

export interface TeamMember {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  role: 'OWNER' | 'MEMBER';
  joinedAt: string;
}

export interface TeamInvite {
  id: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  invitedBy: string;
  createdAt: string;
}

export interface PendingInvite {
  id: string;
  invitedEmail?: string | null;
  invitedUser: { id: string | null; username: string; email: string | null };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
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
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  githubUsername: string | null;
  notifySignIn: boolean;
  notifyTeamInvite: boolean;
  role: string;
  createdAt: string;
  authProvider?: 'local' | 'google' | 'github';
  signOnMethod?: 'local' | 'google' | 'github';
  canEditIdentityFields?: boolean;
  canChangePassword?: boolean;
}

export interface ManagementUser {
  id: string;
  username: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: 'USER' | 'ADMIN' | 'ROOT';
  isActive?: boolean;
  authProvider?: 'local' | 'google' | 'github';
  signOnMethod?: 'local' | 'google' | 'github';
  linkedProviders?: Array<'google' | 'github'>;
  hasPasswordAuth?: boolean;
  createdAt: string;
  _count: { teamMembers: number };
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
    username: string;
    email: string;
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
  username: string;
  teamId: string | null;
  teamName: string | null;
  planName: string | null;
  planDisplayName: string | null;
  planPriceMonthly: number | null;
  subscriptionStatus: string | null;
}

export interface RootAlert {
  id: string;
  kind: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | string;
  title: string;
  message: string;
  relatedAuditLogId: string | null;
  isRead: boolean;
  createdAt: string;
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
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataTypeId: number }[];
  rowCount: number;
  duration: number;
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
  page: number;
  limit: number;
  totalPages: number;
}

export interface RealmUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  createdTimestamp: number;
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
  /** When set, import runs into this existing Kolaybase project (same DB/realm). */
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
