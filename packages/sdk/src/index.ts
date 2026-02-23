export { createClient, KolaybaseClient } from './KolaybaseClient.js';
export { QueryBuilder } from './modules/database.js';
export { StorageClient, StorageBucketApi } from './modules/storage.js';
export { AuthClient } from './modules/auth.js';

export type {
  KolaybaseClientOptions,
  KolaybaseResponse,
  KolaybaseError,
  AuthTokens,
  SignUpCredentials,
  SignInCredentials,
  User,
  Session,
  AuthChangeEvent,
  AuthChangeListener,
  TableInfo,
  ColumnInfo,
  SqlResult,
  FilterOperator,
  Filter,
  OrderClause,
  StorageBucket,
  StorageObject,
  UploadOptions,
  SignedUrlOptions,
} from './lib/types.js';
