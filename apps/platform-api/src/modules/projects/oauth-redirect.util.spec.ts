import { describeAllowedRedirects, resolveOAuthRedirect } from './oauth-redirect.util';

const ALLOWED = ['https://admin.talyasmart.com/login/google', 'http://localhost:3000'];

describe('oauth-redirect.util', () => {
  it('sends the browser to a registered app URL', () => {
    expect(resolveOAuthRedirect('https://admin.talyasmart.com/login/google', ALLOWED)).toBe(
      'https://admin.talyasmart.com/login/google',
    );
  });

  it('keeps the query the app asked for', () => {
    expect(
      resolveOAuthRedirect('https://admin.talyasmart.com/login/google?next=%2Fseo', ALLOWED),
    ).toBe('https://admin.talyasmart.com/login/google?next=%2Fseo');
  });

  it('covers paths under a registered URL, and a bare origin covers all of them', () => {
    expect(
      resolveOAuthRedirect('https://admin.talyasmart.com/login/google/done', ALLOWED),
    ).toBe('https://admin.talyasmart.com/login/google/done');
    expect(resolveOAuthRedirect('http://localhost:3000/auth/callback', ALLOWED)).toBe(
      'http://localhost:3000/auth/callback',
    );
  });

  it('drops a fragment the app brought, so the tokens can be appended', () => {
    expect(resolveOAuthRedirect('http://localhost:3000/cb#stale', ALLOWED)).toBe(
      'http://localhost:3000/cb',
    );
  });

  it('refuses a host, scheme, port or sibling path the project never registered', () => {
    expect(resolveOAuthRedirect('https://evil.test/steal', ALLOWED)).toBeNull();
    expect(resolveOAuthRedirect('http://admin.talyasmart.com/login/google', ALLOWED)).toBeNull();
    expect(resolveOAuthRedirect('http://localhost:3001/cb', ALLOWED)).toBeNull();
    expect(resolveOAuthRedirect('https://admin.talyasmart.com/login/googleXXX', ALLOWED)).toBeNull();
    expect(resolveOAuthRedirect('javascript:alert(1)', ALLOWED)).toBeNull();
    expect(resolveOAuthRedirect('https://admin.talyasmart.com/login/google', [])).toBeNull();
  });

  it('keeps relative paths without any registration', () => {
    expect(resolveOAuthRedirect(undefined, [])).toBe('/');
    expect(resolveOAuthRedirect('', [])).toBe('/');
    expect(resolveOAuthRedirect('/welcome', [])).toBe('/welcome');
    expect(resolveOAuthRedirect('/auth/cb?x=1', [])).toBe('/auth/cb?x=1');
  });

  it('refuses the shapes that only look relative', () => {
    expect(resolveOAuthRedirect('//evil.test', [])).toBeNull();
    expect(resolveOAuthRedirect('/\\evil.test', [])).toBeNull();
    expect(resolveOAuthRedirect('evil.test', [])).toBeNull();
  });

  it('ignores malformed entries instead of failing the sign-in', () => {
    expect(
      resolveOAuthRedirect('https://admin.talyasmart.com/login/google', [
        '',
        'not a url',
        'https://admin.talyasmart.com',
      ]),
    ).toBe('https://admin.talyasmart.com/login/google');
  });

  it('names the registered URLs for the developer-facing error', () => {
    expect(describeAllowedRedirects(ALLOWED)).toBe(
      'https://admin.talyasmart.com/login/google, http://localhost:3000',
    );
    expect(describeAllowedRedirects([])).toContain('URL configuration');
  });
});
