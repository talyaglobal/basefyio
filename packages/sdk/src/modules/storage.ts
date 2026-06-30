import type { BasefyioFetchClient } from '../lib/fetch.js';
import type {
  BasefyioResponse,
  StorageBucket,
  StorageObject,
  UploadOptions,
  SignedUrlOptions,
} from '../lib/types.js';

// ── Bucket-scoped API (bf.storage.from('avatars')) ──────

export class StorageBucketApi {
  private http: BasefyioFetchClient;
  private projectId: string;
  private bucket: string;

  constructor(http: BasefyioFetchClient, projectId: string, bucket: string) {
    this.http = http;
    this.projectId = projectId;
    this.bucket = bucket;
  }

  private basePath(): string {
    return `/projects/${this.projectId}/storage/buckets/${encodeURIComponent(this.bucket)}`;
  }

  async list(prefix = ''): Promise<BasefyioResponse<StorageObject[]>> {
    try {
      const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
      const data = await this.http.json<StorageObject[]>(`${this.basePath()}/objects${q}`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async upload(
    path: string,
    file: Blob | Uint8Array | ArrayBuffer,
    options?: UploadOptions,
  ): Promise<BasefyioResponse<StorageObject>> {
    try {
      const formData = new FormData();
      const fileName = path.split('/').pop() || 'file';
      const ct = options?.contentType || 'application/octet-stream';

      if (file instanceof Blob) {
        formData.append('file', file, fileName);
      } else {
        const blob = new Blob([file as BlobPart], { type: ct });
        formData.append('file', blob, fileName);
      }

      const { data } = await this.http.request<StorageObject>(
        `${this.basePath()}/objects?path=${encodeURIComponent(path)}`,
        { method: 'POST', body: formData },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async download(path: string): Promise<BasefyioResponse<Blob>> {
    try {
      const { data } = await this.http.blob(
        `${this.basePath()}/objects/download?path=${encodeURIComponent(path)}`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async createSignedUrl(path: string, options?: SignedUrlOptions): Promise<BasefyioResponse<{ url: string; expiresIn: number }>> {
    try {
      const expiry = options?.expiresIn ?? 3600;
      const data = await this.http.json<{ url: string; expiresIn: number }>(
        `${this.basePath()}/objects/url?path=${encodeURIComponent(path)}&expiry=${expiry}`,
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async remove(paths: string[]): Promise<BasefyioResponse<{ message: string }>> {
    try {
      const data = await this.http.json<{ message: string }>(`${this.basePath()}/objects`, {
        method: 'DELETE',
        body: JSON.stringify({ paths }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  getPublicUrl(path: string): string {
    return `${this.http.getBaseUrl()}/projects/${this.projectId}/storage/buckets/${encodeURIComponent(this.bucket)}/objects/download?path=${encodeURIComponent(path)}`;
  }
}

// ── Storage Client ──────────────────────────────────────

export class StorageClient {
  private http: BasefyioFetchClient;
  private projectId: string;

  constructor(http: BasefyioFetchClient, projectId: string) {
    this.http = http;
    this.projectId = projectId;
  }

  private basePath(): string {
    return `/projects/${this.projectId}/storage`;
  }

  from(bucket: string): StorageBucketApi {
    return new StorageBucketApi(this.http, this.projectId, bucket);
  }

  async listBuckets(): Promise<BasefyioResponse<StorageBucket[]>> {
    try {
      const data = await this.http.json<StorageBucket[]>(`${this.basePath()}/buckets`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async createBucket(name: string, options?: { public?: boolean }): Promise<BasefyioResponse<StorageBucket>> {
    try {
      const data = await this.http.json<StorageBucket>(`${this.basePath()}/buckets`, {
        method: 'POST',
        body: JSON.stringify({ name, public: options?.public ?? false }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async deleteBucket(name: string): Promise<BasefyioResponse<{ message: string }>> {
    try {
      const data = await this.http.json<{ message: string }>(
        `${this.basePath()}/buckets/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async updateBucket(name: string, options: { public: boolean }): Promise<BasefyioResponse<StorageBucket>> {
    try {
      const data = await this.http.json<StorageBucket>(
        `${this.basePath()}/buckets/${encodeURIComponent(name)}`,
        { method: 'PATCH', body: JSON.stringify(options) },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }
}
