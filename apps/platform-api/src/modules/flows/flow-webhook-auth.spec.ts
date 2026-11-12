import { createHmac } from 'crypto';
import {
  generateWebhookId,
  generateWebhookSecret,
  safeRequestHeaders,
  verifyWebhookRequest,
  webhookSecretError,
} from './flow-webhook-auth';

const secret = 'fwhs_test_secret_value_1234567890';
const body = Buffer.from('{"event":"push"}');
const hmac = (payload: string | Buffer) => createHmac('sha256', secret).update(payload).digest('hex');

describe('flow webhook auth', () => {
  it('accepts the secret in X-Webhook-Secret or as a Bearer token', () => {
    expect(verifyWebhookRequest(secret, { headers: { 'x-webhook-secret': secret } })).toBe('secret');
    expect(verifyWebhookRequest(secret, { headers: { authorization: `Bearer ${secret}` } })).toBe('bearer');
  });

  it('refuses a wrong or missing secret', () => {
    expect(verifyWebhookRequest(secret, { headers: { 'x-webhook-secret': 'nope' } })).toBeNull();
    expect(verifyWebhookRequest(secret, { headers: {} })).toBeNull();
    expect(verifyWebhookRequest('', { headers: { 'x-webhook-secret': '' } })).toBeNull();
  });

  it('verifies an HMAC signature of the raw body (basefyio and GitHub header names)', () => {
    const sig = `sha256=${hmac(body)}`;
    expect(verifyWebhookRequest(secret, { headers: { 'x-basefyio-signature': sig }, rawBody: body })).toBe('hmac');
    expect(verifyWebhookRequest(secret, { headers: { 'x-hub-signature-256': sig }, rawBody: body })).toBe('hmac');
    expect(
      verifyWebhookRequest(secret, { headers: { 'x-hub-signature-256': sig }, rawBody: Buffer.from('{"event":"tampered"}') }),
    ).toBeNull();
  });

  it('does not fall back to another form when a signature is present but wrong', () => {
    expect(
      verifyWebhookRequest(secret, {
        headers: { 'x-basefyio-signature': `sha256=${'0'.repeat(64)}`, 'x-webhook-secret': secret },
        rawBody: body,
      }),
    ).toBeNull();
  });

  it('verifies a Stripe signature within the tolerance window', () => {
    const t = 1_700_000_000;
    const v1 = hmac(Buffer.concat([Buffer.from(`${t}.`), body]));
    const headers = { 'stripe-signature': `t=${t},v1=${v1}` };
    expect(verifyWebhookRequest(secret, { headers, rawBody: body, nowSeconds: t + 10 })).toBe('stripe');
    expect(verifyWebhookRequest(secret, { headers, rawBody: body, nowSeconds: t + 3600 })).toBeNull();
  });

  it('generates unguessable ids and secrets', () => {
    expect(generateWebhookId()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(generateWebhookSecret()).toMatch(/^fwhs_[A-Za-z0-9_-]{43}$/);
    expect(generateWebhookId()).not.toBe(generateWebhookId());
  });

  it('validates a user-supplied secret', () => {
    expect(webhookSecretError('short')).toContain('at least');
    expect(webhookSecretError('has spaces in it here')).toContain('printable');
    expect(webhookSecretError('whsec_abcdefghijklmnop')).toBeNull();
  });

  it('keeps no credentials or proxy internals from the request headers', () => {
    expect(
      safeRequestHeaders({
        authorization: 'Bearer x',
        'x-webhook-secret': 's',
        'x-hub-signature-256': 'sha256=…',
        'stripe-signature': 't=1',
        cookie: 'a=b',
        'x-forwarded-for': '1.2.3.4',
        'x-github-event': 'push',
        'content-type': 'application/json',
      }),
    ).toEqual({ 'x-github-event': 'push', 'content-type': 'application/json' });
  });
});
