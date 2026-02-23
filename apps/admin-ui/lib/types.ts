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
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  keycloakRealm: string;
  keycloakUrl: string;
  anonKey: string;
  serviceKey: string;
}
