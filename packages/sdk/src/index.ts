export { createClient } from './client';
export type { ClientOptions, ProjectClient } from './client';

export { createPlatformClient } from './platform-client';
export type { PlatformClientOptions, PlatformClient } from './platform-client';

export { BasefyioError, ApiError, NetworkError } from './errors';

export { AuthResource } from './resources/auth';
export { ProjectsResource } from './resources/projects';
export { SqlResource } from './resources/sql';
export { StorageResource } from './resources/storage';

export type {
  AuthSession,
  AuthUser,
  CreateProjectParams,
  CreateBucketParams,
  HealthResult,
  ListObjectsOptions,
  ObjectUrlOptions,
  Project,
  SignInParams,
  SignUpParams,
  SqlExecuteOptions,
  SqlField,
  SqlResult,
  SqlResultSet,
  StorageBucket,
  StorageObject,
  UpdateBucketParams,
  UpdateProjectParams,
} from './types';
