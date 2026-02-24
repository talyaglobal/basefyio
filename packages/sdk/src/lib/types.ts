// ── Client options ──────────────────────────────────────

export const KOLAYBASE_DEFAULT_API_URL = 'https://api.kolaybase.com';

export interface KolaybaseClientOptions {
  /** Platform API URL. Defaults to KOLAYBASE_API_URL env or https://api.kolaybase.com */
  apiUrl?: string;
  /** Project ID. Defaults to KOLAYBASE_PROJECT_ID env. */
  projectId?: string;
  /** Anon or service key. Defaults to KOLAYBASE_ANON_KEY env. */
  apiKey?: string;
  autoRefreshToken?: boolean;
  headers?: Record<string, string>;
}

// ── Generic response wrapper ────────────────────────────

export interface KolaybaseResponse<T> {
  data: T | null;
  error: KolaybaseError | null;
}

export interface KolaybaseError {
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
}

export interface SignUpCredentials {
  username: string;
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface SignInCredentials {
  username: string;
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

export type AuthChangeEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED';
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
