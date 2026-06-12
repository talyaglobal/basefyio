export { createClient, BasefyioClient } from './BasefyioClient.js';
export { QueryBuilder, OrConditionBuilder } from './modules/database.js';
export { StorageClient, StorageBucketApi } from './modules/storage.js';
export { AuthClient } from './modules/auth.js';
export { CollectionManager, CollectionClient, DocumentQuery } from './modules/collection.js';

export { BASEFYIO_DEFAULT_API_URL } from './lib/types.js';

export type {
  BasefyioClientOptions,
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
} from './modules/data-engine.js';

export { ProvisioningClient } from './modules/provisioning.js';

export type {
  ProvisioningProjectCreateInput,
  ProvisioningProjectCreateResult,
  ProvisioningProjectStatus,
  ProvisioningOperationCreateInput,
  ProvisioningOperation,
  ProvisioningListOperationsOptions,
  ProvisioningResource,
  ProvisioningCredentialRef,
  ProvisioningCredentialRefCreateInput,
  ProvisioningWaitOptions,
  ProvisioningAuditEvent,
  ProvisioningEventPage,
  ListOperationEventsOptions,
  ResourceDetail,
  ResourcePage,
  ListResourcesOptions,
} from './lib/types.js';

export { ItemsClient, createItemsModule } from './modules/items.js';
export type { ItemsModule } from './modules/items.js';
export type { Item, ItemsPage, ListItemsOptions } from './lib/types.js';
