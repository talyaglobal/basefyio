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
  dbName: string;
  dbHost: string;
  dbPort: number;
  keycloakRealm: string;
  anonKey: string;
  serviceKey: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED';
  createdAt: string;
  updatedAt: string;
  github?: GitHubIntegration;
  vercel?: VercelIntegration;
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
  invitedUser: { id: string; username: string; email: string };
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType?: string;
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
  email: string;
  avatarUrl: string | null;
  githubUsername: string | null;
  notifySignIn: boolean;
  notifyTeamInvite: boolean;
  role: string;
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
  sendNotificationEmails?: boolean;
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
