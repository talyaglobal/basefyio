import { HttpClient } from '../http';
import type {
  CreateBucketParams,
  ListObjectsOptions,
  ObjectUrlOptions,
  StorageBucket,
  StorageObject,
  UpdateBucketParams,
} from '../types';

export class StorageResource {
  private readonly base: string;

  constructor(
    private readonly http: HttpClient,
    projectId: string,
  ) {
    this.base = `/projects/${projectId}/storage`;
  }

  // ── Buckets ────────────────────────────────────────────────────────────────

  listBuckets(): Promise<StorageBucket[]> {
    return this.http.get(`${this.base}/buckets`);
  }

  createBucket(params: CreateBucketParams): Promise<StorageBucket> {
    return this.http.post(`${this.base}/buckets`, params);
  }

  updateBucket(bucketName: string, params: UpdateBucketParams): Promise<StorageBucket> {
    return this.http.patch(`${this.base}/buckets/${bucketName}`, params);
  }

  deleteBucket(bucketName: string): Promise<void> {
    return this.http.del(`${this.base}/buckets/${bucketName}`);
  }

  getBucketPublicUrl(bucketName: string): Promise<{ url: string }> {
    return this.http.get(`${this.base}/buckets/${bucketName}/public-url`);
  }

  // ── Objects ────────────────────────────────────────────────────────────────

  listObjects(bucketName: string, opts: ListObjectsOptions = {}): Promise<StorageObject[]> {
    const params = new URLSearchParams();
    if (opts.prefix) params.set('prefix', opts.prefix);
    if (opts.limit != null) params.set('limit', String(opts.limit));
    if (opts.offset != null) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return this.http.get(`${this.base}/buckets/${bucketName}/objects${qs ? `?${qs}` : ''}`);
  }

  getObjectUrl(bucketName: string, objectPath: string, opts: ObjectUrlOptions = {}): Promise<{ url: string }> {
    const params = new URLSearchParams({ key: objectPath });
    if (opts.expiresIn != null) params.set('expiresIn', String(opts.expiresIn));
    if (opts.download != null) params.set('download', String(opts.download));
    return this.http.get(`${this.base}/buckets/${bucketName}/objects/url?${params.toString()}`);
  }

  moveObject(bucketName: string, sourcePath: string, destinationPath: string): Promise<void> {
    return this.http.post(`${this.base}/buckets/${bucketName}/objects/move`, {
      sourcePath,
      destinationPath,
    });
  }

  deleteObject(bucketName: string, path: string): Promise<void> {
    return this.http.del(`${this.base}/buckets/${bucketName}/objects`, { path });
  }

  createFolder(bucketName: string, folderPath: string): Promise<void> {
    return this.http.post(`${this.base}/buckets/${bucketName}/folders`, { folderPath });
  }
}
