/**
 * Per-claim session settings for row-level security.
 *
 * Policies read the request's identity in two shapes: the whole token as JSON
 * under `request.jwt.claims` (what auth.jwt() parses) and single values under
 * `request.jwt.claim.<name>` — the shape an imported schema's auth.uid(),
 * auth.role() and auth.email() were written against. Publishing both keeps
 * every policy working whichever helper definition the database carries.
 *
 * Values are strings; an absent claim is the empty string, which the imported
 * helpers turn into NULL with nullif(), so an anonymous request has no uid.
 */
export function jwtClaimSettings(
  role: string,
  claims: Record<string, unknown> | undefined,
): Array<[key: string, value: string]> {
  const claim = (name: string): string => {
    const v = claims?.[name];
    return v === undefined || v === null ? '' : String(v);
  };
  return [
    ['request.jwt.claim.sub', claim('sub')],
    ['request.jwt.claim.role', role],
    ['request.jwt.claim.email', claim('email')],
  ];
}
