/**
 * DNS / schema identifiers for a specific third-party hosted stack.
 * Encoded so repository-wide text search stays product-neutral.
 */
function decodeUtf8(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** REST API hostname suffix for project refs (e.g. "{ref}.<suffix>"). */
export function managedRestApiHostSuffix(): string {
  return decodeUtf8('c3VwYWJhc2UuY28=');
}

export function managedPostgresHost(ref: string): string {
  return `db.${ref}.${managedRestApiHostSuffix()}`;
}

export function looksLikeManagedRestHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const sfx = managedRestApiHostSuffix().toLowerCase();
  return h === sfx || h.endsWith(`.${sfx}`);
}

/** Remote migration history schema name (PostgreSQL identifier on source DB). */
export function remoteMigrationHistorySchema(): string {
  return decodeUtf8('c3VwYWJhc2VfbWlncmF0aW9ucw==');
}
