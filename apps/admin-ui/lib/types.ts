export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  dbName: string;
  dbHost: string;
  dbPort: number;
  keycloakRealm: string;
  anonKey: string;
  serviceKey: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED';
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
}

export interface UserInfo {
  sub: string;
  email: string;
  preferred_username: string;
  roles: string[];
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
  name: string;
  teamId: string;
}

export interface SupabaseImportJobResponse {
  jobId: string;
  project: {
    id: string;
    name: string;
    slug: string;
  };
}

export interface ImportProgressData {
  database: { tables: number; rows: number; failedTables: string[] };
  auth: { users: number; skipped: number; emailsSent: number };
  storage: { buckets: number; objects: number };
  warnings: string[];
}

export interface ImportJobProgressEvent {
  step: 'database' | 'auth' | 'storage' | 'completed' | 'failed';
  detail: string;
  percent: number;
  progress?: ImportProgressData;
  error?: string;
}

export interface SupabaseValidateResult {
  valid: boolean;
  projectName: string;
  tableCount: number;
}
