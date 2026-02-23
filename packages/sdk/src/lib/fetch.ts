import type { KolaybaseError } from './types.js';

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

export class KolaybaseFetchClient {
  private baseUrl: string;
  private globalHeaders: Record<string, string>;
  private tokenAccessor: () => string | null;

  constructor(
    baseUrl: string,
    globalHeaders: Record<string, string>,
    tokenAccessor: () => string | null,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.globalHeaders = globalHeaders;
    this.tokenAccessor = tokenAccessor;
  }

  private buildHeaders(custom?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.globalHeaders,
      ...custom,
    };
    const token = this.tokenAccessor();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async request<T = unknown>(path: string, options: FetchOptions = {}): Promise<{ data: T; response: Response }> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders(options.headers);

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ?? null,
    });

    if (!res.ok) {
      let message = `Request failed with status ${res.status}`;
      try {
        const body = await res.json();
        message = body.message || message;
      } catch {}
      const err: KolaybaseError = { message, status: res.status };
      throw err;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = (await res.json()) as T;
      return { data, response: res };
    }

    return { data: null as T, response: res };
  }

  async json<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
    const { data } = await this.request<T>(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
    return data;
  }

  async blob(path: string, options: FetchOptions = {}): Promise<{ data: Blob; response: Response }> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders(options.headers);

    const res = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ?? null,
    });

    if (!res.ok) {
      let message = `Request failed with status ${res.status}`;
      try {
        const body = await res.json();
        message = body.message || message;
      } catch {}
      throw { message, status: res.status } as KolaybaseError;
    }

    const data = await res.blob();
    return { data, response: res };
  }

  getBaseUrl() {
    return this.baseUrl;
  }
}
