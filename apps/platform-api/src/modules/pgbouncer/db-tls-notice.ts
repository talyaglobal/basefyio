/**
 * Pure helpers for the database TLS notice (see DbTlsNoticeService).
 *
 * The pooler refuses a plaintext connection before the startup packet, so a refusal never
 * names the user. Operations therefore sets `projects.db_tls_notice_at` by hand, and the
 * platform clears it once the project's database user is seen connected with TLS.
 */

/**
 * The database users that hold at least one TLS client connection, from `SHOW CLIENTS`
 * rows. PgBouncer fills the `tls` column with e.g. `TLSv1.3/TLS_AES_256_GCM_SHA384/...`
 * for an encrypted client and leaves it empty otherwise.
 */
export function tlsUsersFromClients(rows: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const users = new Set<string>();
  for (const row of rows ?? []) {
    const user = typeof row?.user === 'string' ? row.user : '';
    const tls = typeof row?.tls === 'string' ? row.tls.trim() : '';
    if (user && /^TLS/i.test(tls)) users.add(user);
  }
  return users;
}

/** The ids of the flagged projects whose database user is connected with TLS. */
export function projectsToClear(
  flagged: ReadonlyArray<{ id: string; dbUser: string }>,
  tlsUsers: ReadonlySet<string>,
): string[] {
  return flagged.filter((p) => p.dbUser && tlsUsers.has(p.dbUser)).map((p) => p.id);
}
