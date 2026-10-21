import { jwtClaimSettings } from './jwt-claim-settings';

/**
 * An imported schema's auth.uid() reads request.jwt.claim.sub, while the data
 * API publishes the token as one JSON value. These are the per-claim settings
 * that bridge the two; the empty string is deliberate, because nullif() turns
 * it into NULL and an anonymous request must have no uid.
 */
describe('jwtClaimSettings', () => {
  it('publishes sub, role and email from the claims and the role', () => {
    expect(
      jwtClaimSettings('authenticated', { sub: 'u-1', email: 'a@example.com', extra: 1 }),
    ).toEqual([
      ['request.jwt.claim.sub', 'u-1'],
      ['request.jwt.claim.role', 'authenticated'],
      ['request.jwt.claim.email', 'a@example.com'],
    ]);
  });

  it('uses the empty string for an absent claim so nullif() yields NULL', () => {
    expect(jwtClaimSettings('anon', undefined)).toEqual([
      ['request.jwt.claim.sub', ''],
      ['request.jwt.claim.role', 'anon'],
      ['request.jwt.claim.email', ''],
    ]);
    expect(jwtClaimSettings('authenticated', { sub: null })).toEqual(
      expect.arrayContaining([['request.jwt.claim.sub', '']]),
    );
  });

  it('stringifies a non-string claim rather than dropping it', () => {
    expect(jwtClaimSettings('authenticated', { sub: 42 })[0]).toEqual(['request.jwt.claim.sub', '42']);
  });
});
