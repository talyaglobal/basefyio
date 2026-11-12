export { createClient, BasefyioClient } from './BasefyioClient.js';
export { QueryBuilder, OrConditionBuilder } from './modules/database.js';
export type { FullTableOptions, UpsertOptions } from './modules/database.js';
export { VERSION } from './version.js';
export { BasefyioClientError } from './lib/errors.js';
export type { ClientErrorCode } from './lib/errors.js';
export { StorageClient, StorageBucketApi } from './modules/storage.js';
export { AuthClient } from './modules/auth.js';
export type {
  MfaChallenge,
  SignInResponse,
  SignInWithTotp,
  MfaEnrollment,
  MfaEnrollmentResult,
  MfaStatus,
  AnonymousUpgradeCredentials,
} from './modules/auth.js';
export { CollectionManager, CollectionClient, DocumentQuery } from './modules/collection.js';

export { BASEFYIO_DEFAULT_API_URL } from './lib/types.js';

export type {
  BasefyioClientOptions,
  AuthOptions,
  AuthStorage,
  BasefyioResponse,
  BasefyioError,
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
  OrFilter,
  OrderClause,
  StorageBucket,
  StorageObject,
  UploadOptions,
  SignedUrlOptions,
} from './lib/types.js';

export type {
  CollectionInfo,
  Document,
  DocumentListResult,
  NoSqlFilter,
} from './modules/collection.js';

export { DataEngineClient, EntityClient, DataEngineQuery } from './modules/data-engine.js';

export type {
  DataEngineDocument,
  DataEnginePage,
  EntityInfo,
  DataEngineFilter,
  DataEngineSort,
  DataEngineWriteOptions,
} from './modules/data-engine.js';

export { RealtimeClient } from './modules/realtime.js';
export type {
  RealtimeChangePayload,
  RealtimeChangeType,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
} from './modules/realtime.js';

export { RealtimeChannel } from './modules/realtime.js';
export type {
  RealtimeClientOptions,
  RealtimeTransport,
  RealtimeChannelOptions,
  RealtimeBroadcastMessage,
  RealtimePresenceEvent,
  RealtimePresenceMember,
  RealtimeReady,
} from './modules/realtime.js';

export type {
  ImageTransform,
  PublicUrlOptions,
  ResumableUploadOptions,
  UploadProgress,
  UploadSession,
  StoragePolicyMode,
  StoragePolicy,
  SetStoragePolicyInput,
  StorageListOptions,
  CopyOptions,
  RemoveResult,
  BucketLimits,
  CreateBucketOptions,
  UpdateBucketOptions,
  DeleteBucketOptions,
} from './modules/storage.js';
