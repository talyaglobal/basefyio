/**
 * Pure helpers behind `basefyio db rotate-password`.
 *
 * Rotation is the one database operation that breaks running apps on purpose:
 * the old password stops working the moment the API answers. Everything the
 * user is told about that lives here so it can be tested.
 */

export type CredentialTarget = 'owner' | 'readonly';

/** The connection details `GET /api/projects/:id/connect` returns (subset the CLI shows). */
export interface ProjectConnectInfo {
  uri: string;
  poolerUri: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolerHost: string;
  poolerPort: number;
}

/** What `--json` prints and the human output is built from. */
export interface RotationReport {
  projectId: string;
  target: CredentialTarget;
  user: string | null;
  password: string;
  /** Present for the owner credential when the connect route could be read. */
  connectionString?: string;
  directConnectionString?: string;
}

export function buildRotationReport(input: {
  projectId: string;
  target: CredentialTarget;
  password: string;
  user?: string | null;
  connect?: ProjectConnectInfo | null;
}): RotationReport {
  const report: RotationReport = {
    projectId: input.projectId,
    target: input.target,
    user: input.user ?? (input.target === 'owner' ? input.connect?.user ?? null : null),
    password: input.password,
  };
  // The connect route describes the owner credential only; never pair its URIs
  // with a read-only password.
  if (input.target === 'owner' && input.connect) {
    report.connectionString = input.connect.poolerUri || input.connect.uri;
    report.directConnectionString = input.connect.uri;
  }
  return report;
}

/** The connect route re-reads the stored credential; it must carry the password just issued. */
export function connectMatchesRotation(connect: ProjectConnectInfo | null | undefined, password: string): boolean {
  return !!connect && connect.password === password;
}

/** Shown before asking for confirmation. */
export function rotationWarningLines(target: CredentialTarget, projectName: string): string[] {
  const who = target === 'owner' ? 'owner database user' : 'read-only database user';
  return [
    `This generates a new password for the ${who} of "${projectName}".`,
    'The current password stops working immediately: every app, server, CI job and tool',
    'that connects with it will fail until you give it the new one.',
    target === 'owner'
      ? 'The dashboard and the basefyio API pick the new password up automatically.'
      : 'Only clients that use the read-only user are affected.',
  ];
}

/** Shown after a successful rotation. */
export function afterRotationLines(target: CredentialTarget, wroteEnv: boolean): string[] {
  const lines: string[] = [];
  if (target === 'owner') {
    lines.push(
      wroteEnv
        ? 'Updated .env in this directory (DATABASE_URL, DIRECT_URL, BASEFYIO_DB_PASSWORD, …).'
        : 'Update DATABASE_URL / DIRECT_URL wherever your apps keep them (run with --write-env to update .env here).',
    );
  } else {
    lines.push('Update the connection string of every client that uses the read-only user.');
  }
  lines.push('The pooled connection (port 6432) accepts the new password within a few seconds.');
  return lines;
}
