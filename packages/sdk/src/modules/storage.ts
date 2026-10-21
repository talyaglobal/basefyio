import type { BasefyioFetchClient } from '../lib/fetch.js';
import type {
  BasefyioError,
  BasefyioResponse,
  StorageBucket,
  StorageObject,
  UploadOptions,
  SignedUrlOptions,
} from '../lib/types.js';

// ── Image transforms (getPublicUrl(path, { transform })) ──

/** Resize and re-encode options applied by the API when the image is read. */
export interface ImageTransform {
  width?: number;
  height?: number;
  format?: 'jpeg' | 'png' | 'webp' | 'avif';
  /** 1-100, default 80 */
  quality?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
}

export interface PublicUrlOptions {
  /** When given, the URL points at the render route, which resizes and re-encodes on read. */
  transform?: ImageTransform;
}

const TRANSFORM_KEYS = ['width', 'height', 'format', 'quality', 'fit'] as const;

// ── Access rules (bf.storage.setBucketPolicy) ────────────

/**
 * How API-key callers may reach a bucket or a key prefix. No rule = any valid
 * key may read. The service key and dashboard team members are never restricted.
 */
export type StoragePolicyMode = 'public-read' | 'authenticated-read' | 'owner-only';

export interface StoragePolicy {
  id: string;
  projectId: string;
  bucket: string;
  /** '' = the whole bucket; the longest matching prefix wins. */
  pathPrefix: string;
  mode: StoragePolicyMode;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetStoragePolicyInput {
  mode: StoragePolicyMode;
  pathPrefix?: string;
}

// ── Resumable uploads (bf.storage.from('b').uploadResumable) ──

export interface UploadProgress {
  uploaded: number;
  total: number;
  percent: number;
}

export interface UploadSession {
  id: string;
  bucket: string;
  path: string;
  /** Bytes the server has stored so far. */
  offset: number;
  size: number;
  /** Every chunk except the last must be exactly this long. */
  chunkSize: number;
  contentType: string;
  status: string;
  expiresAt: string;
}

export interface ResumableUploadOptions {
  contentType?: string;
  /** Bytes per chunk; the server clamps it to 5–64 MiB. */
  chunkSize?: number;
  /** Consecutive failed chunks tolerated before giving up (default 3). */
  maxRetries?: number;
  /** Delay before the first retry in ms, doubled each time (default 500). */
  retryDelayMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

const CHUNK_CONTENT_TYPE = 'application/offset+octet-stream';
/** Statuses that mean "do not try again": the request itself is wrong. */
const NON_RETRYABLE = new Set([400, 401, 403, 404, 410, 413, 415]);

function toBlob(file: Blob | Uint8Array | ArrayBuffer, contentType?: string): Blob {
  if (file instanceof Blob) return file;
  return new Blob([file as BlobPart], { type: contentType || 'application/octet-stream' });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  // ── Resumable uploads ────────────────────────────────

  private sessionsPath(): string {
    return `${this.basePath()}/upload-sessions`;
  }

  async createUploadSession(
    path: string,
    size: number,
    options?: { contentType?: string; chunkSize?: number },
  ): Promise<BasefyioResponse<UploadSession>> {
    try {
      const data = await this.http.json<UploadSession>(this.sessionsPath(), {
        method: 'POST',
        body: JSON.stringify({ path, size, contentType: options?.contentType, chunkSize: options?.chunkSize }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async getUploadSession(sessionId: string): Promise<BasefyioResponse<UploadSession>> {
    try {
      const data = await this.http.json<UploadSession>(`${this.sessionsPath()}/${encodeURIComponent(sessionId)}`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async abortUpload(sessionId: string): Promise<BasefyioResponse<{ id: string; status: string }>> {
    try {
      const data = await this.http.json<{ id: string; status: string }>(
        `${this.sessionsPath()}/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  /**
   * Uploads a file in chunks through a resumable session. A failed chunk is
   * retried after re-reading the server's offset, so a dropped connection
   * costs one chunk, not the file. `resumeUpload()` continues a session later.
   */
  async uploadResumable(
    path: string,
    file: Blob | Uint8Array | ArrayBuffer,
    options?: ResumableUploadOptions,
  ): Promise<BasefyioResponse<StorageObject & { sessionId: string }>> {
    try {
      const blob = toBlob(file, options?.contentType);
      const session = await this.http.json<UploadSession>(this.sessionsPath(), {
        method: 'POST',
        body: JSON.stringify({
          path,
          size: blob.size,
          contentType: options?.contentType ?? (blob.type || undefined),
          chunkSize: options?.chunkSize,
        }),
      });
      const data = await this.driveSession(session, blob, options);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async resumeUpload(
    sessionId: string,
    file: Blob | Uint8Array | ArrayBuffer,
    options?: ResumableUploadOptions,
  ): Promise<BasefyioResponse<StorageObject & { sessionId: string }>> {
    try {
      const session = await this.http.json<UploadSession>(`${this.sessionsPath()}/${encodeURIComponent(sessionId)}`);
      const data = await this.driveSession(session, toBlob(file, options?.contentType), options);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  private async driveSession(
    session: UploadSession,
    blob: Blob,
    options?: ResumableUploadOptions,
  ): Promise<StorageObject & { sessionId: string }> {
    const sessionPath = `${this.sessionsPath()}/${encodeURIComponent(session.id)}`;
    const total = blob.size;
    if (total !== session.size) {
      throw { message: `File is ${total} bytes but the session expects ${session.size}`, status: 400 } as BasefyioError;
    }
    const chunk = session.chunkSize;
    const maxRetries = options?.maxRetries ?? 3;
    const baseDelay = options?.retryDelayMs ?? 500;
    let offset = session.offset;
    let failures = 0;

    const report = () =>
      options?.onProgress?.({
        uploaded: offset,
        total,
        percent: total === 0 ? 100 : Math.floor((offset / total) * 100),
      });
    report();

    while (offset < total) {
      if (options?.signal?.aborted) {
        await this.http.json(sessionPath, { method: 'DELETE' }).catch(() => undefined);
        throw { message: 'Upload aborted', status: 0 } as BasefyioError;
      }
      const slice = blob.slice(offset, Math.min(offset + chunk, total));
      try {
        const { data, response } = await this.http.request<{ offset?: number } | null>(sessionPath, {
          method: 'PATCH',
          headers: { 'Upload-Offset': String(offset), 'Content-Type': CHUNK_CONTENT_TYPE },
          body: slice,
        });
        const fromBody = typeof data?.offset === 'number' ? data.offset : NaN;
        const fromHeader = Number(response.headers.get('Upload-Offset'));
        const next = Number.isFinite(fromBody) ? fromBody : fromHeader;
        offset = Number.isFinite(next) && next > offset ? next : offset + slice.size;
        failures = 0;
      } catch (err: any) {
        if (typeof err?.status === 'number' && NON_RETRYABLE.has(err.status)) throw err;
        failures++;
        if (failures > maxRetries) throw err;
        await sleep(baseDelay * 2 ** (failures - 1));
        // Ask the server where it really is before sending the next chunk.
        const fresh = await this.http.json<UploadSession>(sessionPath);
        offset = fresh.offset;
      }
      report();
    }

    const result = await this.http.json<StorageObject>(`${sessionPath}/complete`, { method: 'POST' });
    return { ...result, sessionId: session.id };
  }

  getPublicUrl(path: string, options?: PublicUrlOptions): string {
    const objects = `${this.http.getBaseUrl()}/projects/${this.projectId}/storage/buckets/${encodeURIComponent(this.bucket)}/objects`;
    const transform = options?.transform;
    if (!transform) {
      return `${objects}/download?path=${encodeURIComponent(path)}`;
    }
    // A browser loads this through <img src>, which cannot send headers, so the
    // public key travels in the query string (the API accepts only the anon key there).
    let url = `${objects}/render?path=${encodeURIComponent(path)}`;
    for (const key of TRANSFORM_KEYS) {
      const value = transform[key];
      if (value === undefined || value === null) continue;
      const text = String(value);
      if (!text) continue;
      url += `&${key}=${encodeURIComponent(text)}`;
    }
    return `${url}&apikey=${encodeURIComponent(this.http.getApiKey())}`;
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

  // ── Access rules (service key) ───────────────────────

  async getPolicies(): Promise<BasefyioResponse<StoragePolicy[]>> {
    try {
      const data = await this.http.json<StoragePolicy[]>(`${this.basePath()}/policies`);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  /** Set the rule for a bucket (or a prefix inside it). The bucket must be private. */
  async setBucketPolicy(bucket: string, input: SetStoragePolicyInput): Promise<BasefyioResponse<StoragePolicy>> {
    try {
      const data = await this.http.json<StoragePolicy>(
        `${this.basePath()}/buckets/${encodeURIComponent(bucket)}/policy`,
        { method: 'PUT', body: JSON.stringify(input) },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async removeBucketPolicy(bucket: string, pathPrefix = ''): Promise<BasefyioResponse<{ removed: number }>> {
    try {
      const data = await this.http.json<{ removed: number }>(
        `${this.basePath()}/buckets/${encodeURIComponent(bucket)}/policy?pathPrefix=${encodeURIComponent(pathPrefix)}`,
        { method: 'DELETE' },
      );
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }
}
