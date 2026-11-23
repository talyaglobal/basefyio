import type { EnvSecrets } from './config.js';

/** A masked URI from the new server holds this instead of the password. */
const PASSWORD_PLACEHOLDER = '[YOUR-PASSWORD]';

export interface ResolvedSecrets {
  /** The credentials found; null when none could be obtained. */
  secrets: (EnvSecrets & { serviceKeyRevealable?: boolean }) | null;
  /** Where they came from: the reveal endpoint, or the fields an older server still returns. */
  source: 'reveal' | 'legacy' | 'none';
  /** A message for the user (permission refused, request failed); null when all went well. */
  message: string | null;
  /** The reveal endpoint answered 403: the role may not see the credentials. */
  denied: boolean;
}

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const realUri = (v: unknown): string | null => {
  const s = nonEmpty(v);
  return s && !s.includes(PASSWORD_PLACEHOLDER) ? s : null;
};

/**
 * The project's credentials, working against both servers (#14).
 *
 * - New server: `POST /api/projects/:id/secrets/reveal`. 403 means the role may not see them;
 *   that is reported, never swallowed.
 * - Older server (the route answers 404 or 405): the project read and `GET connect` still carry
 *   `dbPassword` / `password` and `serviceKey`, so those are used.
 *
 * Nothing here ever invents a value: a credential no source has stays null.
 */
export async function resolveProjectSecrets(
  reveal: () => Promise<any>,
  legacy: { project?: any; connect?: any },
): Promise<ResolvedSecrets> {
  try {
    const data = await reveal();
    return {
      secrets: {
        password: nonEmpty(data?.password),
        uri: realUri(data?.uri),
        poolerUri: realUri(data?.poolerUri),
        serviceKey: nonEmpty(data?.serviceKey),
        serviceKeyRevealable: data?.serviceKeyRevealable !== false,
      },
      source: 'reveal',
      message: null,
      denied: false,
    };
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 403) {
      const detail = nonEmpty(err?.response?.data?.message);
      return {
        secrets: null,
        source: 'none',
        denied: true,
        message:
          `Your role cannot see this project's credentials${detail ? ` (${detail})` : ''}. ` +
          'Ask a team owner or admin, or for the "reset database password" permission.',
      };
    }
    if (status === 404 || status === 405) {
      const password = nonEmpty(legacy.connect?.password) ?? nonEmpty(legacy.project?.dbPassword);
      const serviceKey = nonEmpty(legacy.connect?.serviceKey) ?? nonEmpty(legacy.project?.serviceKey);
      const uri = realUri(legacy.connect?.uri);
      const poolerUri = realUri(legacy.connect?.poolerUri);
      if (!password && !serviceKey && !uri && !poolerUri) {
        return { secrets: null, source: 'none', denied: false, message: null };
      }
      return { secrets: { password, serviceKey, uri, poolerUri }, source: 'legacy', denied: false, message: null };
    }
    return {
      secrets: null,
      source: 'none',
      denied: false,
      message: `Could not fetch the credentials${err?.message ? `: ${err.message}` : ''}.`,
    };
  }
}
