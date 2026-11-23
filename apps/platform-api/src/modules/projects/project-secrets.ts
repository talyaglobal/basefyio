import { ConfigService } from '@nestjs/config';
import {
  buildPostgresUri,
  encPgPart,
  getPgbouncerClientEndpoints,
  getPostgresDirectClientEndpoints,
} from './postgres-uri.util';

/**
 * Credentials stored on the project row. None of them leaves the API in a general project
 * response (read, list, update, realtime, MCP): the dashboard asks for them on demand through
 * `POST /projects/:id/secrets/reveal`, which checks the caller's role and writes an activity
 * entry. The anon key is public and stays in every response.
 */
export const PROJECT_SECRET_FIELDS = [
  'dbPassword',
  'serviceKey',
  'dbReadonlyPassword',
  'githubToken',
  'vercelToken',
  'embeddingApiKey',
] as const;

export type ProjectSecretField = (typeof PROJECT_SECRET_FIELDS)[number];

/** Relations that hold credentials of their own; dropped too if a query ever includes them. */
const SECRET_RELATIONS = ['extraRoles', 'secretKeys', 'infrastructure'] as const;

/** A copy of `row` without any stored credential. */
export function stripProjectSecrets<T extends Record<string, any>>(
  row: T,
): Omit<T, ProjectSecretField | (typeof SECRET_RELATIONS)[number]> {
  const out: Record<string, any> = { ...row };
  for (const field of PROJECT_SECRET_FIELDS) delete out[field];
  for (const rel of SECRET_RELATIONS) delete out[rel];
  return out as Omit<T, ProjectSecretField | (typeof SECRET_RELATIONS)[number]>;
}

/**
 * The create response: the creator gets the generated database password and the service key
 * once, because `basefyio init` writes them into `.env`. Every other stored credential is left
 * out, and no later read returns them.
 */
export function projectCreationResponse<T extends Record<string, any>>(row: T) {
  const { dbPassword, serviceKey } = row;
  return { ...stripProjectSecrets(row), dbPassword, serviceKey };
}

/** What the masked connection details put where a password would be. */
export const PASSWORD_PLACEHOLDER = '[YOUR-PASSWORD]';

function maskedPostgresUri(host: string, port: number, user: string, database: string): string {
  return `postgresql://${encPgPart(user)}:${PASSWORD_PLACEHOLDER}@${host}:${port}/${database}`;
}

export interface ConnectionProjectFields {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword?: string | null;
  keycloakRealm: string;
  anonKey: string;
  serviceKey?: string | null;
  dbReadonlyUser?: string | null;
  dbReadonlyPassword?: string | null;
  extraRoles?: Array<{
    id: string;
    label: string;
    roleName: string;
    password?: string | null;
    memberOf: string;
    createdAt: Date | string;
  }>;
}

/**
 * The Connection page's details. Masked (the default): every password and the service key is
 * `null` and the URIs carry `[YOUR-PASSWORD]`; the shape is otherwise the same, so a client
 * that reads hosts, ports, users, the realm or the anon key keeps working. `reveal: true` is
 * only used by the reveal endpoint.
 */
export function buildConnectionDetails(
  project: ConnectionProjectFields,
  config: ConfigService,
  opts: { reveal?: boolean } = {},
) {
  const reveal = opts.reveal === true;
  const db = project.dbName;
  const user = project.dbUser;
  const publicApiUrl = config.get<string>('publicApiUrl') || 'http://localhost:4000';
  const publicBaseUrl = publicApiUrl.replace(/\/+$/, '');

  // External PgBouncer endpoint — what users connect to from pgAdmin, DBeaver, etc.
  const { host: poolerHost, port: poolerPort } = getPgbouncerClientEndpoints(config);
  const { host: directHost, port: directPort } = getPostgresDirectClientEndpoints(config, poolerHost, poolerPort);

  const uris = (roleUser: string, password: string | null | undefined) =>
    reveal && password
      ? {
          uri: buildPostgresUri(directHost, directPort, roleUser, password, db),
          poolerUri: buildPostgresUri(poolerHost, poolerPort, roleUser, password, db),
        }
      : {
          uri: maskedPostgresUri(directHost, directPort, roleUser, db),
          poolerUri: maskedPostgresUri(poolerHost, poolerPort, roleUser, db),
        };

  return {
    ...uris(user, project.dbPassword),
    host: poolerHost,
    port: directPort,
    database: db,
    user,
    password: reveal ? (project.dbPassword ?? null) : null,
    poolerHost,
    poolerPort,
    restUrl: `${publicApiUrl}/api/rest/v1`,
    publicBaseUrl,
    keycloakRealm: project.keycloakRealm,
    keycloakUrl: config.get('keycloak.publicUrl') || config.get('keycloak.url'),
    anonKey: project.anonKey,
    serviceKey: reveal ? (project.serviceKey ?? null) : null,
    // SELECT-only companion role; null until the team creates it.
    readonly: project.dbReadonlyUser && project.dbReadonlyPassword
      ? {
          user: project.dbReadonlyUser,
          password: reveal ? (project.dbReadonlyPassword ?? null) : null,
          ...uris(project.dbReadonlyUser, project.dbReadonlyPassword),
        }
      : null,
    // Extra named login roles; empty array until any are created.
    extraRoles: (project.extraRoles ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      user: r.roleName,
      password: reveal ? (r.password ?? null) : null,
      memberOf: r.memberOf,
      ...uris(r.roleName, r.password),
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    })),
    /** True on the general read: fetch the values from `POST /projects/:id/secrets/reveal`. */
    secretsMasked: !reveal,
  };
}
