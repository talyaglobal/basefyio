import { createHash } from 'crypto';

/**
 * Profile photos saved from the dashboard are stored inline, as a base64
 * `data:` URL in `users.avatar_url` (~90 KB each). Embedding that string in
 * every member list and profile response made a 12-member team cost half a
 * megabyte. Responses now carry a short link to `GET /api/avatars/:userId/:version`
 * instead, which serves the decoded image with long-lived caching.
 *
 * The version is a hash of the stored value: the link changes whenever the
 * photo changes (so it can be cached forever), and nobody can fetch a photo
 * without first having been shown its link by an authorised response.
 */

/** Largest decoded profile photo accepted on save (matches the dashboard's limit). */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const AVATAR_ROUTE = '/api/avatars';

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]*)$/i;

export interface ImageDataUrl {
  mimeType: string;
  data: Buffer;
}

export function isDataUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith('data:');
}

/** Decodes a base64 `data:image/...` URL; null for anything else. */
export function parseImageDataUrl(value: string | null | undefined): ImageDataUrl | null {
  if (!isDataUrl(value)) return null;
  const match = DATA_URL_RE.exec(value);
  if (!match) return null;
  const data = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (data.length === 0) return null;
  return { mimeType: match[1].toLowerCase(), data };
}

/** Short, stable fingerprint of the stored avatar value. */
export function avatarVersion(stored: string): string {
  return createHash('sha256').update(stored).digest('hex').slice(0, 20);
}

function trimBase(apiBaseUrl: string): string {
  return (apiBaseUrl || '').replace(/\/+$/, '');
}

/** The link that serves an inline avatar. */
export function avatarLink(userId: string, stored: string, apiBaseUrl: string): string {
  return `${trimBase(apiBaseUrl)}${AVATAR_ROUTE}/${encodeURIComponent(userId)}/${avatarVersion(stored)}`;
}

/**
 * What API responses carry in `avatarUrl`: an http(s) link passes through
 * unchanged; an inline `data:` image becomes a link to the avatar endpoint.
 */
export function publicAvatarUrl(
  userId: string,
  stored: string | null | undefined,
  apiBaseUrl: string,
): string | null {
  if (!stored) return null;
  if (!isDataUrl(stored)) return stored;
  return avatarLink(userId, stored, apiBaseUrl);
}

/**
 * True when `value` is the avatar link this API itself handed out for the
 * user. Clients that send the profile back unchanged must not overwrite the
 * stored photo with a link to itself.
 */
export function isOwnAvatarLink(userId: string, value: string, apiBaseUrl: string): boolean {
  const prefix = `${trimBase(apiBaseUrl)}${AVATAR_ROUTE}/${encodeURIComponent(userId)}/`;
  if (value.startsWith(prefix)) return true;
  // Also accept the same path behind another host (dashboard proxy, local dev).
  try {
    const path = new URL(value).pathname;
    return path.startsWith(`${AVATAR_ROUTE}/${encodeURIComponent(userId)}/`)
      || path.startsWith(`/api/proxy/avatars/${encodeURIComponent(userId)}/`);
  } catch {
    return false;
  }
}

export type AvatarInputCheck =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Validates a new `avatarUrl` on profile update. Accepted: empty (removes the
 * photo), an http(s) link, or a base64 image `data:` URL up to MAX_AVATAR_BYTES.
 */
export function checkAvatarInput(value: string): AvatarInputCheck {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (/^https?:\/\//i.test(trimmed)) {
    if (trimmed.length > 2048) return { ok: false, message: 'Profile photo link is too long' };
    return { ok: true, value: trimmed };
  }
  if (isDataUrl(trimmed)) {
    const parsed = parseImageDataUrl(trimmed);
    if (!parsed) {
      return { ok: false, message: 'Profile photo must be a JPG, PNG, GIF or WebP image' };
    }
    if (parsed.data.length > MAX_AVATAR_BYTES) {
      return { ok: false, message: 'Profile photo must be 2 MB or smaller' };
    }
    return { ok: true, value: trimmed };
  }
  return { ok: false, message: 'Profile photo must be an image upload or an http(s) link' };
}
