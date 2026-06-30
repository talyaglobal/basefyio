import { ApiError, NetworkError } from './errors';

export type FetchFn = typeof fetch;

interface RequestInit_ {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export class HttpClient {
  private token: string | null = null;
  private apiKey: string | null = null;

  // The platform API mounts every route under the `api` global prefix except
  // the unauthenticated liveness probe — mirroring the server's
  // `setGlobalPrefix('api', { exclude: ['health'] })`. Callers pass clean paths
  // (`/projects`, `/health`); the prefix is applied centrally in resolvePath().
  private static readonly API_PREFIX = '/api';
  private static readonly UNPREFIXED = ['/health'];

  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: FetchFn,
  ) {}

  private resolvePath(path: string): string {
    const unprefixed = HttpClient.UNPREFIXED.some(
      (p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`),
    );
    return unprefixed ? path : `${HttpClient.API_PREFIX}${path}`;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  setApiKey(key: string | null): void {
    this.apiKey = key;
  }

  getToken(): string | null {
    return this.token;
  }

  private authHeaders(): Record<string, string> {
    if (this.token) return { Authorization: `Bearer ${this.token}` };
    if (this.apiKey) return { 'x-api-key': this.apiKey };
    return {};
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit_ = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${this.resolvePath(path)}`, init as RequestInit);
    } catch (err) {
      throw new NetworkError(`Network error on ${method} ${path}: ${(err as Error).message}`, err);
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as Record<string, unknown> | null;
      const message = (errorBody?.message as string) ?? `HTTP ${response.status}`;
      throw new ApiError(message, response.status, errorBody);
    }

    const text = await response.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  del<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('DELETE', path, body);
  }
}
