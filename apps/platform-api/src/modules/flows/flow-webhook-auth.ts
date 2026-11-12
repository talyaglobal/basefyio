import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * How a caller proves it may fire a flow's webhook, without holding the
 * project's service key.
 *
 * Each webhook flow has its own URL (an unguessable id) and its own secret.
 * The secret never travels in the URL — URLs end up in proxy and access logs —
 * only in a header, in one of these forms:
 *
 *  - `X-Webhook-Secret: <secret>` or `Authorization: Bearer <secret>`
 *    for callers that can only set a static header;
 *  - `X-Basefyio-Signature: sha256=<hex HMAC-SHA256 of the raw body>`, also
 *    accepted as `X-Hub-Signature-256` (the form GitHub sends);
 *  - `Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`
 *    (paste Stripe's signing secret as the flow's secret), checked against a
 *    five-minute tolerance so a captured request cannot be replayed later.
 *
 * Every comparison is constant-time.
 */

export const STRIPE_TOLERANCE_SECONDS = 300;
export const SECRET_MIN_LENGTH = 16;
export const SECRET_MAX_LENGTH = 256;

export type WebhookAuthMethod = 'secret' | 'bearer' | 'hmac' | 'stripe';

export interface WebhookAuthInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  nowSeconds?: number;
}

export function generateWebhookId(): string {
  return randomBytes(24).toString('base64url');
}

export function generateWebhookSecret(): string {
  return `fwhs_${randomBytes(32).toString('base64url')}`;
}

/** null when acceptable as a user-supplied secret, else why not. */
export function webhookSecretError(secret: unknown): string | null {
  if (typeof secret !== 'string') return 'secret must be a string';
  if (secret.length < SECRET_MIN_LENGTH) return `secret must be at least ${SECRET_MIN_LENGTH} characters`;
  if (secret.length > SECRET_MAX_LENGTH) return `secret must be at most ${SECRET_MAX_LENGTH} characters`;
  if (!/^[\x21-\x7e]+$/.test(secret)) return 'secret must be printable ASCII without spaces';
  return null;
}

function header(headers: WebhookAuthInput['headers'], name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still spend the comparison so a length mismatch is not faster.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function hmacHex(secret: string, payload: Buffer | string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * The method the request authenticated with, or null. A signature header that
 * is present but wrong fails outright — it never falls through to another form.
 */
export function verifyWebhookRequest(secret: string, input: WebhookAuthInput): WebhookAuthMethod | null {
  if (!secret) return null;
  const body = input.rawBody ?? Buffer.alloc(0);

  const stripe = header(input.headers, 'stripe-signature');
  if (stripe) {
    const parts = stripe.split(',').map((p) => p.trim().split('='));
    const t = parts.find(([k]) => k === 't')?.[1];
    const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
    if (!t || !/^\d+$/.test(t) || !v1s.length) return null;
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(t)) > STRIPE_TOLERANCE_SECONDS) return null;
    const expected = hmacHex(secret, Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]));
    return v1s.some((v) => safeEqual(v.toLowerCase(), expected)) ? 'stripe' : null;
  }

  const sig = header(input.headers, 'x-basefyio-signature') ?? header(input.headers, 'x-hub-signature-256');
  if (sig) {
    const m = sig.trim().match(/^sha256=([0-9a-fA-F]{64})$/);
    if (!m) return null;
    return safeEqual(m[1].toLowerCase(), hmacHex(secret, body)) ? 'hmac' : null;
  }

  const plain = header(input.headers, 'x-webhook-secret');
  if (plain !== undefined) return safeEqual(plain.trim(), secret) ? 'secret' : null;

  const auth = header(input.headers, 'authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    return safeEqual(auth.replace(/^Bearer\s+/i, '').trim(), secret) ? 'bearer' : null;
  }
  return null;
}

/** Request headers worth keeping on the run (no credentials, no proxy internals). */
const DROP_HEADERS = /^(authorization|proxy-authorization|cookie|apikey|x-api-key|x-webhook-secret|x-basefyio-signature|x-hub-signature(-256)?|stripe-signature|x-forwarded-.*|x-real-ip|forwarded|cf-.*|true-client-ip|x-trace-id|connection|content-length|host)$/i;

export function safeRequestHeaders(headers: WebhookAuthInput['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || DROP_HEADERS.test(k)) continue;
    out[k.toLowerCase()] = (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 1024);
    if (++n >= 50) break;
  }
  return out;
}
