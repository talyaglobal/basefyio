// Strips credential and key material from pg driver error messages before
// re-throwing. pg itself does not embed SSL key bytes, but this provides
// belt-and-suspenders protection for connection-string credentials and any
// unexpected PEM fragments.

export function sanitizePgError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);

  const safe = raw
    // Strip inline credentials from postgresql:// connection strings
    .replace(/:[^:@\s]*@/g, ':[REDACTED]@')
    // Strip password= query params
    .replace(/password=[^&\s'"]+/gi, 'password=[REDACTED]')
    // Strip any PEM block that should never appear in error messages
    .replace(/-----BEGIN[\w\s]+-----[\s\S]*?-----END[\w\s]+-----/g, '[KEY_MATERIAL_REDACTED]');

  const out = new Error(safe);
  out.name = 'DatabaseError';

  // Preserve pg error code (e.g. ECONNREFUSED, 28P01 wrong_password)
  if (err && typeof err === 'object' && 'code' in err) {
    (out as any).code = (err as any).code;
  }

  return out;
}
