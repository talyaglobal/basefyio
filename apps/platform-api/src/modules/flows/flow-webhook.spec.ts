/**
 * Unit tests for webhook signature verification and sensitive header masking.
 * Both are pure-function concerns that don't need Nest bootstrapping.
 */
import { createHmac } from 'crypto';
import { verifyWebhookSignature } from './flows.service';

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret-abc123';

  it('returns true for a valid signature', () => {
    const body = '{"event":"push"}';
    const sig = sign(secret, body);
    expect(verifyWebhookSignature(secret, Buffer.from(body), sig)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const body = '{"event":"push"}';
    const sig = sign(secret, body);
    expect(verifyWebhookSignature(secret, Buffer.from('{"event":"delete"}'), sig)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const body = '{"event":"push"}';
    const sig = sign('wrong-secret', body);
    expect(verifyWebhookSignature(secret, Buffer.from(body), sig)).toBe(false);
  });

  it('returns false when the prefix is missing', () => {
    const body = '{}';
    const bare = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
    expect(verifyWebhookSignature(secret, Buffer.from(body), bare)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(verifyWebhookSignature(secret, Buffer.from('{}'), '')).toBe(false);
  });
});
