import { BadRequestException } from '@nestjs/common';
import {
  isValidAppState,
  mapOAuthError,
  parseAppState,
  parseOAuthPrompt,
  withFragmentParams,
  withQueryParams,
} from './oauth-return.util';

describe('parseOAuthPrompt', () => {
  it.each(['login', 'select_account', 'consent', 'none'])('accepts %s', (p) => {
    expect(parseOAuthPrompt(p)).toBe(p);
  });

  it('treats an absent value as no prompt', () => {
    expect(parseOAuthPrompt(undefined)).toBeUndefined();
    expect(parseOAuthPrompt('')).toBeUndefined();
  });

  it.each(['LOGIN', 'login consent', 'login&kc_idp_hint=x', 'select-account', ['login'], 5])('refuses %j', (p) => {
    expect(() => parseOAuthPrompt(p)).toThrow(BadRequestException);
  });
});

describe('parseAppState', () => {
  it('accepts URL-safe values up to 512 characters', () => {
    expect(parseAppState('abc-DEF_123.~')).toBe('abc-DEF_123.~');
    expect(parseAppState('a'.repeat(512))).toHaveLength(512);
  });

  it.each(['a'.repeat(513), 'a b', 'x#y', 'a&b=c', '<script>', 'é', '%2F'])('refuses %j', (s) => {
    expect(() => parseAppState(s)).toThrow(BadRequestException);
    expect(isValidAppState(s)).toBe(false);
  });
});

describe('mapOAuthError', () => {
  it('keeps the codes it knows and folds the rest into oauth_failed', () => {
    expect(mapOAuthError('access_denied')).toBe('access_denied');
    expect(mapOAuthError('login_required')).toBe('login_required');
    expect(mapOAuthError('account_selection_required')).toBe('interaction_required');
    expect(mapOAuthError('<b>pwned</b>')).toBe('oauth_failed');
    expect(mapOAuthError(undefined)).toBe('oauth_failed');
  });
});

describe('return URL builders', () => {
  it('appends a fragment, skipping undefined values', () => {
    expect(withFragmentParams('https://app.example.com/cb?x=1', { a: '1', b: undefined, c: 'x y' })).toBe(
      'https://app.example.com/cb?x=1#a=1&c=x+y',
    );
    expect(withFragmentParams('https://app.example.com/', {})).toBe('https://app.example.com/');
  });

  it('adds to an existing query', () => {
    expect(withQueryParams('https://app.example.com/cb?x=1', { error: 'access_denied' })).toBe(
      'https://app.example.com/cb?x=1&error=access_denied',
    );
    expect(withQueryParams('https://app.example.com/cb', { error: 'e' })).toBe('https://app.example.com/cb?error=e');
  });
});
