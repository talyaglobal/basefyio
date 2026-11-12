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
  /** Session handling for `bf.auth`. */
  auth?: AuthOptions;
}

/**
 * Where a persisted session is kept: `localStorage` in a browser by default,
 * or anything with the same three methods (sync or async — e.g. AsyncStorage
 * in React Native).
 */
export interface AuthStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface AuthOptions {
  /**
   * Keep the session across page loads. Off by default: the session lives in
   * memory only, as it always has. Turned on, the tokens are stored in
   * `storage` — readable by any script on the page, so only enable it where
   * that is acceptable. Await `bf.auth.ready()` before reading the session.
   */
  persistSession?: boolean;
  /** Defaults to `globalThis.localStorage` when it exists. */
  storage?: AuthStorage;
  /** Defaults to `basefyio.auth.<projectId>`. */
  storageKey?: string;
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

/**
 * - `SIGNED_IN` — a sign-in, sign-up, OAuth callback or MFA step produced a session.
 * - `TOKEN_REFRESHED` — the access token was renewed.
 * - `SIGNED_OUT` — the session ended (signOut, or a refresh the server refused).
 * - `EMAIL_VERIFIED` / `EMAIL_CHANGED` — after verifyEmail / confirmChangeEmail.
 * - `INITIAL_SESSION` — with `persistSession`, once the stored session (or none) is restored.
 */
export type AuthChangeEvent =
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'EMAIL_VERIFIED'
  | 'EMAIL_CHANGED'
  | 'INITIAL_SESSION';
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

/**
 * A query's rows. Column values arrive as the database driver reads them:
 * `bigint`, `numeric` and `count(*)` (a bigint) as **strings**, so no digit of
 * a large number is lost to floating point — convert with `Number()` or
 * `BigInt()` where that is safe. json/jsonb arrive parsed, timestamps as
 * strings.
 */
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
