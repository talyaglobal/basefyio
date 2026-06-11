// ── Client options ──────────────────────────────────────

export const BASEFYIO_DEFAULT_API_URL = 'https://api.basefyio.com';

export interface BasefyioClientOptions {
  /** Platform API URL. Defaults to BASEFYIO_API_URL env (fallback: KOLAYBASE_API_URL) or https://api.basefyio.com */
  apiUrl?: string;
  /** Project ID. Defaults to BASEFYIO_PROJECT_ID env (fallback: KOLAYBASE_PROJECT_ID). */
  projectId?: string;
  /** Anon or service key. Defaults to BASEFYIO_ANON_KEY env (fallback: KOLAYBASE_ANON_KEY). */
  apiKey?: string;
  autoRefreshToken?: boolean;
  headers?: Record<string, string>;
}

// ── Generic response wrapper ────────────────────────────

export interface BasefyioResponse<T> {
  data: T | null;
  error: BasefyioError | null;
}

export interface BasefyioError {
  message: string;
  status?: number;
  code?: string;
}

// ── Auth types ──────────────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  userId?: string;
  emailVerified?: boolean;
}

export interface SignUpCredentials {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface SignInCredentials {
  email: string;
  password: string;
}

export interface User {
  sub: string;
  email: string;
  preferred_username: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

export interface Session {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface VerifyEmailResult {
  message: string;
}

export interface ForgotPasswordResult {
  message: string;
}

export interface ResetPasswordResult {
  message: string;
}

export interface MagicLinkResult {
  message: string;
}

export interface MagicLinkVerifyResult {
  message: string;
  userId: string;
  email: string;
  emailVerified: boolean;
}

export interface ChangeEmailResult {
  message: string;
}

export interface ConfirmChangeEmailResult {
  message: string;
  newEmail: string;
}

export interface ReauthResult {
  message: string;
}

export interface ReauthVerifyResult {
  message: string;
  userId: string;
  verified: boolean;
}

export interface InviteUserResult {
  message: string;
}

export interface OAuthRedirectResult {
  url: string;
  provider: string;
}

export type OAuthProvider = 'google' | 'github';

export type AuthChangeEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'EMAIL_VERIFIED' | 'EMAIL_CHANGED';
export type AuthChangeListener = (event: AuthChangeEvent, session: Session | null) => void;

// ── Database types ──────────────────────────────────────

export interface TableInfo {
  name: string;
  schema: string;
  rowCount?: number;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimary: boolean;
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  fields?: { name: string; dataTypeID?: number }[];
  rowCount: number;
}

export type FilterOperator =
  | 'eq' | 'neq'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'like' | 'ilike'
  | 'is' | 'in'
  | 'not';

export interface Filter {
  column: string;
  operator: FilterOperator;
  value: unknown;
  negate?: boolean;
}

export interface OrFilter {
  column: string;
  operator: FilterOperator;
  value: unknown;
  negate?: boolean;
}

export interface OrderClause {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

// ── Storage types ───────────────────────────────────────

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

export interface UploadOptions {
  contentType?: string;
}

export interface SignedUrlOptions {
  expiresIn?: number;
}

// ── Provisioning types ──────────────────────────────────

export interface ProvisioningProjectCreateInput {
  projectId: string;
  credentialRefId: string;
  region: string;
  datacenter?: string;
  provider?: string;
  desiredSpec: Record<string, unknown>;
  dryRun: boolean;
  idempotencyKey: string;
}

export interface ProvisioningProjectCreateResult {
  provisioningProjectId: string;
  provider: string;
  status: string;
  operation: {
    provisioningOperationId: string;
    status: string;
    dryRun: boolean;
    idempotent: boolean;
  };
}

export interface ProvisioningProjectStatus {
  provisioningProjectId: string;
  provider: string;
  region: string;
  datacenter: string | null;
  status: string;
  createdAt: string;
}

export interface ProvisioningOperationCreateInput {
  projectId: string;
  type: 'CREATE' | 'UPDATE' | 'DELETE' | 'ROLLBACK';
  idempotencyKey: string;
  desiredSpec: Record<string, unknown>;
  dryRun: boolean;
}

export interface ProvisioningOperation {
  id: string;
  projectId: string;
  type: string;
  status: string;
  dryRun: boolean;
  idempotencyKey: string;
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: { message: string } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ProvisioningListOperationsOptions {
  projectId: string;
  status?: string;
  limit?: number;
}

export interface ProvisioningResource {
  id: string;
  projectId: string;
  type: string;
  name: string;
  status: string;
  externalId: string | null;
  desiredSpec: Record<string, unknown>;
  actualSpec: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningCredentialRef {
  credentialRefId: string;
  teamId: string;
  label: string;
  openbaoPath: string;
  provider: string;
  createdAt: string;
}

export interface ProvisioningCredentialRefCreateInput {
  teamId: string;
  label: string;
  openbaoPath: string;
  provider?: string;
}
