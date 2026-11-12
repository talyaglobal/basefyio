import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { Readable } from 'stream';
import { assertSafeUrl } from './flow-url-guard';
import { FlowHttpMethod } from './flow.types';

/**
 * The outbound request behind an `http.request` step.
 *
 * Three things the previous one-line axios call got wrong:
 *  - its 10 s timeout was an idle timeout: a server that kept trickling bytes
 *    held the step (and a worker) for as long as it liked. The limit here is a
 *    hard deadline on the whole exchange, body included.
 *  - a 3xx was reported as success with nothing followed. Redirects are now
 *    followed — up to MAX_REDIRECTS hops, each target re-checked by the SSRF
 *    guard before it is requested, credentials dropped when the host changes.
 *  - nothing of the response was kept. The body is read up to a cap (enough
 *    for later steps to template from) and returned with the headers.
 */

export const MAX_REDIRECTS = 5;
/** Bytes of response body read into memory for templating and run details. */
export const MAX_CAPTURE_BYTES = 256 * 1024;

export interface HttpStepRequest {
  method: FlowHttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  followRedirects?: boolean;
}

export interface HttpStepResponse {
  ok: boolean;
  status?: number;
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON and complete, otherwise text. */
  body: unknown;
  truncated: boolean;
  redirects: string[];
  durationMs: number;
  error?: string;
}

export interface HttpDeps {
  request: (config: AxiosRequestConfig) => Promise<AxiosResponse>;
  assertSafeUrl: (url: string) => Promise<void>;
  now: () => number;
}

const defaultDeps: HttpDeps = {
  request: (config) => axios.request(config),
  assertSafeUrl,
  now: () => Date.now(),
};

/** Response headers never kept: they carry the remote's session, not data. */
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);
/** Request headers dropped when a redirect leaves the original host. */
const CREDENTIAL_HEADERS = /^(authorization|cookie|proxy-authorization)$/i;

function pickHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(name) || v === undefined || v === null) continue;
    out[name] = (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 500);
    if (++n >= 40) break;
  }
  return out;
}

async function readCapped(
  stream: Readable | undefined,
  limit: number,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream || typeof (stream as any).on !== 'function') return { text: '', truncated: false };
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    };
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      reject(err);
    };
    const onAbort = () => {
      stream.destroy();
      fail(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const room = limit - size;
      if (buf.length >= room) {
        chunks.push(buf.subarray(0, Math.max(0, room)));
        size = limit;
        stream.destroy();
        finish(true);
        return;
      }
      chunks.push(buf);
      size += buf.length;
    });
    stream.on('end', () => finish(false));
    stream.on('close', () => finish(false));
    stream.on('error', (err) => fail(err));
  });
}

function parseBody(text: string, contentType: string | undefined, truncated: boolean): unknown {
  if (!text) return null;
  if (!truncated && (contentType?.includes('json') || /^\s*[[{]/.test(text))) {
    try {
      return JSON.parse(text);
    } catch {
      /* not JSON after all */
    }
  }
  return text;
}

function serializeBody(body: unknown, headers: Record<string, string>): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  const hasType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (!hasType) headers['Content-Type'] = 'application/json';
  return JSON.stringify(body);
}

export async function performHttpRequest(
  req: HttpStepRequest,
  deps: HttpDeps = defaultDeps,
): Promise<HttpStepResponse> {
  const started = deps.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const redirects: string[] = [];
  let method: FlowHttpMethod = req.method;
  let url = req.url;
  let headers: Record<string, string> = { ...(req.headers ?? {}) };
  let data = serializeBody(req.body, headers);
  const follow = req.followRedirects !== false;

  const failed = (error: string, status?: number): HttpStepResponse => ({
    ok: false,
    status,
    headers: {},
    body: null,
    truncated: false,
    redirects,
    durationMs: deps.now() - started,
    error,
  });

  try {
    for (let hop = 0; ; hop++) {
      try {
        await deps.assertSafeUrl(url);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return failed(hop === 0 ? why : `redirect to ${url} refused: ${why}`);
      }

      const res = await deps.request({
        method,
        url,
        headers,
        data,
        // Redirects are followed here, one checked hop at a time; letting the
        // client follow them would skip the SSRF guard for every hop after the first.
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'stream',
        signal: controller.signal,
        timeout: req.timeoutMs,
        decompress: true,
      });

      const location = res.headers?.location;
      if (follow && res.status >= 300 && res.status < 400 && location && res.status !== 304) {
        (res.data as Readable | undefined)?.destroy?.();
        if (hop >= MAX_REDIRECTS) return failed(`too many redirects (more than ${MAX_REDIRECTS})`, res.status);
        let next: URL;
        try {
          next = new URL(String(location), url);
        } catch {
          return failed(`redirect with an invalid Location header`, res.status);
        }
        if (new URL(url).host !== next.host) {
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.test(k)));
        }
        // 303 always, and 301/302 for anything but GET/HEAD, become a GET
        // without a body — what browsers and curl -L do.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          data = undefined;
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)),
          );
        }
        url = next.toString();
        redirects.push(url);
        continue;
      }

      const { text, truncated } = await readCapped(res.data as Readable, MAX_CAPTURE_BYTES, controller.signal);
      const resHeaders = pickHeaders(res.headers);
      return {
        ok: res.status >= 200 && res.status < 400,
        status: res.status,
        headers: resHeaders,
        body: parseBody(text, resHeaders['content-type'], truncated),
        truncated,
        redirects,
        durationMs: deps.now() - started,
        error: res.status >= 400 ? `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` : undefined,
      };
    }
  } catch (e) {
    if (controller.signal.aborted) {
      return failed(`timed out after ${Math.round(req.timeoutMs / 100) / 10}s`);
    }
    return failed((e instanceof Error ? e.message : String(e)).slice(0, 300));
  } finally {
    clearTimeout(timer);
  }
}
