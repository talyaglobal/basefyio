/**
 * The credential fields a project record carries. The anon key is public by
 * design (it ships in client bundles) and is not among them.
 */
export const PROJECT_SECRET_FIELDS = ['dbPassword', 'serviceKey', 'dbReadonlyPassword'] as const;

/**
 * Whether `GET /projects/:id` should leave the credentials out.
 *
 * The dashboard asks for `?secrets=omit` on every page load: it fetched the
 * database password and the service key with each project page although the
 * page rarely showed them, and showed them unmasked when it did. Credentials
 * now come from `GET /projects/:id/connect`, on request. Other callers (the
 * CLI, scripts) keep the old answer unless the operator sets
 * `PROJECT_DETAIL_SECRETS=omit`, after which `?secrets=include` still asks for them.
 */
export function shouldOmitProjectSecrets(query: string | undefined): boolean {
  const q = (query || '').trim().toLowerCase();
  if (q === 'omit') return true;
  if (q === 'include') return false;
  return (process.env.PROJECT_DETAIL_SECRETS || 'include').trim().toLowerCase() === 'omit';
}

/** A copy of the project without its credentials, marked so a client can tell. */
export function withoutProjectSecrets<T extends Record<string, unknown>>(project: T): Omit<T, (typeof PROJECT_SECRET_FIELDS)[number]> & { secretsOmitted: true } {
  const copy: Record<string, unknown> = { ...project };
  for (const f of PROJECT_SECRET_FIELDS) delete copy[f];
  copy.secretsOmitted = true;
  return copy as Omit<T, (typeof PROJECT_SECRET_FIELDS)[number]> & { secretsOmitted: true };
}
