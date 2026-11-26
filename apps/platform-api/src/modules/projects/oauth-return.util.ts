/**
 * What an app may add to a social sign-in, and what the browser carries back to it.
 *
 * - `prompt` goes to Keycloak and, through it, to the provider. Only the four OIDC values are
 *   accepted; anything else is a 400, so nothing a caller types reaches Keycloak unchecked.
 * - `state` is the app's own value (CSRF token, a page to return to). It rides inside our
 *   OAuth state and comes back in the fragment untouched. Its shape is limited so it can never
 *   break out of the URL it is written into.
 * - Errors come back as a fixed code, never as Keycloak's or the provider's free text: the app
 *   shows its own message, and a crafted provider answer cannot put words on the app's page.
 */
import { BadRequestException } from '@nestjs/common';

export const OAUTH_PROMPTS = ['login', 'select_account', 'consent', 'none'] as const;
export type OAuthPrompt = (typeof OAUTH_PROMPTS)[number];

/**
 * Sent when the app names no prompt: what the provider configs used to force. Google showed
 * the account chooser and asked for the password again, GitHub asked to sign in again.
 */
export const DEFAULT_PROVIDER_PROMPT: Record<string, string> = {
  google: 'select_account login',
  github: 'login',
};

/** The app's `state`: up to 512 URL-safe characters (RFC 3986 unreserved). */
const APP_STATE = /^[A-Za-z0-9._~-]{1,512}$/;

export function parseOAuthPrompt(value: unknown): OAuthPrompt | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (OAUTH_PROMPTS as readonly string[]).includes(value)) {
    return value as OAuthPrompt;
  }
  throw new BadRequestException(`prompt must be one of: ${OAUTH_PROMPTS.join(', ')}`);
}

export function parseAppState(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && APP_STATE.test(value)) return value;
  throw new BadRequestException(
    'state must be 1-512 characters from A-Z, a-z, 0-9 and "-", ".", "_", "~"',
  );
}

/** The same check on the way back, where a bad value is dropped instead of refused. */
export function isValidAppState(value: unknown): value is string {
  return typeof value === 'string' && APP_STATE.test(value);
}

export const OAUTH_RETURN_ERRORS = {
  access_denied: 'The sign-in was cancelled or refused.',
  login_required: 'No active session; sign in interactively.',
  interaction_required: 'The provider needs the user to interact; sign in without prompt=none.',
  consent_required: 'The provider needs the user to consent; sign in without prompt=none.',
  missing_profile: 'The provider did not share an e-mail address for this account.',
  temporarily_unavailable: 'The sign-in service is temporarily unavailable. Try again.',
  oauth_failed: 'The sign-in could not be completed. Try again.',
} as const;
export type OAuthReturnError = keyof typeof OAUTH_RETURN_ERRORS;

/** Keycloak's / the provider's error code, reduced to one of ours. */
export function mapOAuthError(raw: unknown): OAuthReturnError {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (code in OAUTH_RETURN_ERRORS) return code as OAuthReturnError;
  if (code === 'account_selection_required') return 'interaction_required';
  return 'oauth_failed';
}

/** `#…` parameters appended to an allowlisted redirect (the target never has a fragment of its own). */
export function withFragmentParams(url: string, params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string');
  if (entries.length === 0) return url;
  return `${url}#${new URLSearchParams(entries).toString()}`;
}

/** `?…` parameters added to a redirect, keeping the query it already has. */
export function withQueryParams(url: string, params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string');
  if (entries.length === 0) return url;
  const [base, hash] = url.split('#', 2);
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}${new URLSearchParams(entries).toString()}${hash !== undefined ? `#${hash}` : ''}`;
}
