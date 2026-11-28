/**
 * Which login a backup `pg_dump` of a project database runs as.
 *
 * pg_dump turns row security off and refuses to read any table whose policies
 * would still apply to it. A table with FORCE ROW LEVEL SECURITY applies its
 * policies to the owning role too, so a dump taken as the project's own role
 * fails on such a table ("query would be affected by row-level security
 * policy"). `--enable-row-security` is not an option: it silently leaves out
 * every row a policy hides, and a backup must be complete or fail loudly.
 *
 * So a project that lives on the shared cluster is dumped with the platform's
 * admin login (`database.*`, a superuser), which row security never applies
 * to. The dump flags (`--no-owner --no-acl`) keep the output free of role
 * names and grants, so it restores into the project role exactly as before.
 * A project on a dedicated host keeps its own login: the platform holds no
 * admin credentials for that server here.
 */
export interface AdminLogin {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface DumpLogin {
  host: string;
  port: number;
  user: string;
  password: string;
  /** True when the platform admin login is used (row security cannot apply). */
  admin: boolean;
}

/** The platform admin login, read the same way configuration.ts reads `database.*`. */
export function adminLoginFromEnv(env: NodeJS.ProcessEnv = process.env): AdminLogin {
  return {
    host: env.POSTGRES_HOST || 'localhost',
    port: parseInt(env.POSTGRES_PORT || '5432', 10),
    user: env.POSTGRES_USER || 'kolaybase',
    password: env.POSTGRES_PASSWORD || 'kolaybase_secret',
  };
}

export function resolveDumpLogin(
  project: { dbHost: string | null; dbPort: number | null; dbUser: string; dbPassword: string | null },
  admin: AdminLogin | null,
): DumpLogin {
  const host = project.dbHost || 'postgres';
  const port = Number(project.dbPort || 5432);
  if (admin && admin.user && host === admin.host && port === Number(admin.port)) {
    return { host, port, user: admin.user, password: admin.password, admin: true };
  }
  return { host, port, user: project.dbUser, password: project.dbPassword || '', admin: false };
}

/**
 * A short, secret-free reason for a failed pg_dump: the tail of its stderr
 * (where the real error is), not the echoed command line that `execFile`
 * puts first in `err.message`.
 */
export function dumpFailureReason(err: any, secrets: Array<string | null | undefined> = [], max = 300): string {
  const stderr = String(err?.stderr ?? '').trim();
  let text = stderr || String(err?.message ?? 'unknown error').trim();
  for (const s of secrets) {
    if (s && s.length >= 3) text = text.split(s).join('***');
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `…${text.slice(-max)}` : text;
}
