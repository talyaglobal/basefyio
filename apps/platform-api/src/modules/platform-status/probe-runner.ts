import { Pool } from 'pg';

/** Every outbound probe identifies itself (Cloudflare and friends drop anonymous clients). */
export const PROBE_USER_AGENT = 'basefyio-status-probe/1.0 (+https://basefyio.com/status)';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  statusCode?: number;
  detail?: string;
}

function failure(started: number, err: unknown, timeoutMs: number): ProbeResult {
  const e = err as { name?: string; message?: string };
  const detail = e?.name === 'AbortError' ? `no answer within ${timeoutMs} ms` : String(e?.message ?? err).slice(0, 200);
  return { ok: false, latencyMs: Date.now() - started, detail };
}

/** GET and expect a 2xx within the deadline. The body is read and dropped so the socket is reused. */
export async function httpProbe(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<ProbeResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': PROBE_USER_AGENT, ...headers },
    });
    try {
      await res.arrayBuffer();
    } catch {
      /* a body that cannot be read does not change the verdict */
    }
    const latencyMs = Date.now() - started;
    const ok = res.status >= 200 && res.status < 300 && latencyMs <= timeoutMs;
    return {
      ok,
      latencyMs,
      statusCode: res.status,
      detail: ok ? undefined : res.status >= 200 && res.status < 300 ? `slow: ${latencyMs} ms` : `HTTP ${res.status}`,
    };
  } catch (err) {
    return failure(started, err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

/** Open a server-sent-events stream and wait for the `ready` frame. */
export async function sseProbe(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<ProbeResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': PROBE_USER_AGENT, Accept: 'text/event-stream', ...headers },
    });
    if (!res.ok || !res.body) {
      return { ok: false, latencyMs: Date.now() - started, statusCode: res.status, detail: `HTTP ${res.status}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: ready')) {
        ctrl.abort();
        return { ok: true, latencyMs: Date.now() - started, statusCode: res.status };
      }
      if (buffer.length > 16_384) break;
    }
    return { ok: false, latencyMs: Date.now() - started, statusCode: res.status, detail: 'stream ended before the ready frame' };
  } catch (err) {
    return failure(started, err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

export interface PgProbeTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Connect through the customer-facing pooler with TLS (self-signed, as customers do) and run SELECT 1. */
export async function pgProbe(target: PgProbeTarget, timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  // No statement_timeout here: the pooler runs in transaction mode and
  // rejects it as a startup parameter; query_timeout is enforced client-side.
  const pool = new Pool({
    ...target,
    ssl: { rejectUnauthorized: false },
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  try {
    await pool.query('select 1');
    const latencyMs = Date.now() - started;
    return { ok: latencyMs <= timeoutMs, latencyMs, detail: latencyMs > timeoutMs ? `slow: ${latencyMs} ms` : undefined };
  } catch (err) {
    return failure(started, err, timeoutMs);
  } finally {
    await pool.end().catch(() => {});
  }
}
