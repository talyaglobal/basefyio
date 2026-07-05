import {
  ActionRequest,
  ActionResult,
  AdapterEvent,
  CodefyioAdapter,
  Resource,
} from './codefyio.types';

/**
 * Framework-agnostic, dependency-light HTTP client that fulfils the
 * {@link CodefyioAdapter} contract by calling this product's `/_codefyio` routes.
 * The Codefyio IDE imports this to drive the product from inside the editor;
 * tests import it to exercise a running instance without a NestJS test harness.
 *
 * Uses only global `fetch` (Node 18+ / browsers / Electron). No secrets are
 * logged; the session token is held in memory only.
 */
export class CodefyioHttpAdapter implements CodefyioAdapter {
  private baseUrl = '';
  private codefyioToken = '';
  private accessToken?: string;
  private account?: string;

  async init(ctx: { baseUrl: string; codefyioToken: string }): Promise<void> {
    this.baseUrl = ctx.baseUrl.replace(/\/+$/, '');
    this.codefyioToken = ctx.codefyioToken;
  }

  async authenticate(): Promise<{ account: string }> {
    const res = await this.request('POST', '/_codefyio/auth/exchange', {
      body: { codefyioToken: this.codefyioToken },
      auth: false,
    });
    this.accessToken = res.accessToken;
    this.account = res.account;
    return { account: res.account };
  }

  async getStatus(): Promise<{ status: 'ok' | 'degraded' | 'down'; detail?: string }> {
    try {
      const res = await this.request('GET', '/_codefyio/health', { auth: false });
      return { status: res?.status === 'ok' ? 'ok' : 'degraded' };
    } catch (e: any) {
      return { status: 'down', detail: e?.message };
    }
  }

  async listResources(cursor?: string): Promise<{ items: Resource[]; nextCursor?: string }> {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request('GET', `/_codefyio/resources${q}`);
  }

  async executeAction(a: ActionRequest): Promise<ActionResult> {
    try {
      return await this.request('POST', '/_codefyio/action', { body: a });
    } catch (e: any) {
      return { ok: false, error: e?.message || 'action failed' };
    }
  }

  subscribe(onEvent: (e: AdapterEvent) => void): () => void {
    if (!this.accessToken) throw new Error('authenticate() before subscribe()');
    const url = `${this.baseUrl}/_codefyio/events?token=${encodeURIComponent(this.accessToken)}`;

    // Browser / Electron: native EventSource.
    const ES = (globalThis as any).EventSource;
    if (typeof ES === 'function') {
      const es = new ES(url);
      es.onmessage = (m: MessageEvent) => {
        try {
          onEvent(JSON.parse(m.data));
        } catch {
          /* ignore malformed frame */
        }
      };
      return () => es.close();
    }

    // Node: parse the SSE stream from fetch.
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        const reader = res.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (line) {
              try {
                onEvent(JSON.parse(line.slice(5).trim()));
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch {
        /* aborted or network error */
      }
    })();
    return () => controller.abort();
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; auth?: boolean } = {},
  ): Promise<any> {
    const auth = opts.auth !== false;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) {
      if (!this.accessToken) throw new Error('Not authenticated');
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(data?.message || `HTTP ${res.status}`);
    }
    return data;
  }
}
