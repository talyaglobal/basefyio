import type { Request } from 'express';
import type { ApiKeyPayload } from '../../common/guards/api-key.guard';

/**
 * Who is asking, as far as storage access rules care.
 *
 *  - `service`        the secret service key: never restricted.
 *  - `dashboard`      a signed-in team member (platform JWT): never restricted.
 *  - `authenticated`  the public key plus a verified end-user token.
 *  - `anon`           the public key alone.
 *
 * The guard already settled who may reach a route; this only tells the access
 * rules which of the four they are looking at.
 */
export type StorageCaller =
  | { kind: 'service' }
  | { kind: 'dashboard'; sub: string }
  | { kind: 'authenticated'; sub: string }
  | { kind: 'anon' };

export function storageCaller(req: Request | undefined): StorageCaller {
  const payload = (req as any)?.apiKeyPayload as ApiKeyPayload | undefined;
  if (payload) {
    if (payload.role === 'service') return { kind: 'service' };
    const sub = payload.jwtClaims?.sub;
    if (payload.dbRole === 'authenticated' && typeof sub === 'string' && sub) {
      return { kind: 'authenticated', sub };
    }
    return { kind: 'anon' };
  }
  const user = (req as any)?.user as { sub?: unknown } | undefined;
  if (typeof user?.sub === 'string' && user.sub) return { kind: 'dashboard', sub: user.sub };
  return { kind: 'anon' };
}

/** Callers the access rules never restrict. */
export function isPrivileged(caller: StorageCaller): boolean {
  return caller.kind === 'service' || caller.kind === 'dashboard';
}

/** Identity recorded on an uploaded object; nobody when only a key was presented. */
export function ownerTag(caller: StorageCaller): string | undefined {
  return caller.kind === 'authenticated' || caller.kind === 'dashboard' ? caller.sub : undefined;
}

/** Object metadata header that carries the uploader's identity. */
export const OWNER_META_HEADER = 'x-amz-meta-owner';

/** Metadata to attach to an upload for this caller (empty when there is no identity to record). */
export function ownerMeta(caller: StorageCaller): Record<string, string> {
  const owner = ownerTag(caller);
  return owner ? { [OWNER_META_HEADER]: owner } : {};
}

/**
 * The owner recorded on an object. The client library hands custom metadata
 * back with the `x-amz-meta-` prefix stripped, so `owner` is the usual key;
 * the prefixed spelling is accepted in case a store returns it verbatim.
 */
export function ownerOf(stat: { metaData?: Record<string, unknown> } | null | undefined): string | undefined {
  const meta = stat?.metaData;
  if (!meta) return undefined;
  const value = meta['owner'] ?? meta[OWNER_META_HEADER] ?? meta['Owner'];
  return typeof value === 'string' && value ? value : undefined;
}
