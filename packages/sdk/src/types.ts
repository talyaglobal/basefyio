// ── Auth ──────────────────────────────────────────────────────────────────────

export interface SignInParams {
  email: string;
  password: string;
}

export interface SignUpParams {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
  createdAt: string;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'INACTIVE' | 'DELETED';
  teamId: string;
  region: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectParams {
  name: string;
  teamId: string;
  region?: string;
}

export interface UpdateProjectParams {
  name?: string;
}

// ── SQL ───────────────────────────────────────────────────────────────────────

export interface SqlExecuteOptions {
  page?: number;
  limit?: number;
  countTotal?: boolean;
}

export interface SqlField {
  name: string;
  dataTypeId: number;
}

export interface SqlResultSet {
  fields: SqlField[];
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  fields: SqlField[];
  rowCount: number | null;
  duration: number;
  page: number;
  limit: number;
  paginated: boolean;
  total: number | null;
  totalIsApprox: boolean;
  resultSets: SqlResultSet[];
}

// ── Storage ───────────────────────────────────────────────────────────────────

export interface StorageBucket {
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBucketParams {
  name: string;
  public?: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes?: string[];
}

export interface UpdateBucketParams {
  public?: boolean;
  fileSizeLimit?: number;
  allowedMimeTypes?: string[];
}

export interface StorageObject {
  name: string;
  size: number;
  contentType: string | null;
  lastModified: string;
  etag: string | null;
}

export interface ListObjectsOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
}

export interface ObjectUrlOptions {
  expiresIn?: number;
  download?: boolean;
}

// ── Health ────────────────────────────────────────────────────────────────────

export interface HealthResult {
  status: 'ok' | string;
  [key: string]: unknown;
}
