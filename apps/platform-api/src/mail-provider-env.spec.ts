import { resolveMailBaseUrl } from './mail-provider-env';

/**
 * The mail SDK resolves its API base once, when it is first required, from
 * process.env.RESEND_BASE_URL — its constructor takes only a key. So a key for
 * one provider with no base URL set is sent to the other provider's API and
 * refused, and no later configuration can correct it. Deriving the base from
 * the key itself is what makes a single variable enough.
 */
describe('resolveMailBaseUrl', () => {
  const TSMART = 'https://send.tsmart.ai';

  it('derives the provider from a tsmartSend key', () => {
    expect(resolveMailBaseUrl({ TSMART_SEND_API_KEY: 'ts_abcdefgh_' + 'x'.repeat(32) } as any)).toBe(TSMART);
  });

  it('derives it from the key prefix even under the legacy variable name', () => {
    expect(resolveMailBaseUrl({ RESEND_API_KEY: 'ts_abcdefgh_' + 'x'.repeat(32) } as any)).toBe(TSMART);
  });

  it('leaves a Resend key on its own default', () => {
    expect(resolveMailBaseUrl({ RESEND_API_KEY: 're_something' } as any)).toBeUndefined();
  });

  it('lets an explicit base URL win, so a self-hosted install can point anywhere', () => {
    expect(
      resolveMailBaseUrl({
        RESEND_BASE_URL: 'https://mail.example.test',
        TSMART_SEND_API_KEY: 'ts_abcdefgh_' + 'x'.repeat(32),
      } as any),
    ).toBe('https://mail.example.test');
  });

  it('returns nothing when no key is configured at all', () => {
    expect(resolveMailBaseUrl({} as any)).toBeUndefined();
  });

  it('prefers the provider-neutral name when both keys are present', () => {
    expect(
      resolveMailBaseUrl({ TSMART_SEND_API_KEY: 'ts_abcdefgh_' + 'x'.repeat(32), RESEND_API_KEY: 're_old' } as any),
    ).toBe(TSMART);
  });
});
