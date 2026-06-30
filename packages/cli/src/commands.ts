import type { PlatformClient, Project, SqlResult, StorageBucket } from '@basefyio/sdk';
import type { CliConfig } from './config';

// ── Argument parsing (pure, testable) ─────────────────────────────────────────

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Minimal flag parser: `--key value` → string, bare `--key` (or `--key --next`)
 * → boolean true. Everything else is a positional.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

// ── Injected dependencies (so commands run without real network/fs) ───────────

export interface CommandDeps {
  loadConfig(): CliConfig;
  saveConfig(config: CliConfig): void;
  makeClient(opts: { url: string; token?: string }): PlatformClient;
  out(line: string): void;
  err(line: string): void;
  /** API URL used when neither --url nor saved config provides one. */
  defaultApiUrl: string;
  /** Hidden password prompt; only needed when `login` omits --password. */
  readPassword?(prompt: string): Promise<string>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

// ── Formatting (pure, testable) ───────────────────────────────────────────────

export function formatProjects(projects: Project[]): string {
  if (projects.length === 0) return 'No projects.';
  return projects
    .map((p) => `${p.id}  ${p.slug}  ${p.status}  ${p.name}`)
    .join('\n');
}

export function formatProject(p: Project): string {
  return [
    `ID:      ${p.id}`,
    `Name:    ${p.name}`,
    `Slug:    ${p.slug}`,
    `Status:  ${p.status}`,
    `Created: ${p.createdAt}`,
  ].join('\n');
}

export function formatSqlResult(result: SqlResult): string {
  const count = result.rowCount ?? result.rows.length;
  const header = `${count} row${count === 1 ? '' : 's'}`;
  if (result.rows.length === 0) return header;
  return `${header}\n${result.rows.map((r) => JSON.stringify(r)).join('\n')}`;
}

export function formatBuckets(buckets: StorageBucket[]): string {
  if (buckets.length === 0) return 'No buckets.';
  return buckets
    .map((b) => `${b.name}  ${b.public ? 'public' : 'private'}`)
    .join('\n');
}

// ── Command handlers ──────────────────────────────────────────────────────────

function requireToken(config: CliConfig, deps: CommandDeps): string | null {
  if (!config.token) {
    deps.err('Not logged in. Run: basefyio login --email <you@example.com>');
    return null;
  }
  return config.token;
}

async function cmdLogin(
  flags: Record<string, string | boolean>,
  deps: CommandDeps,
  apiUrl: string,
): Promise<number> {
  const email = flagStr(flags, 'email');
  if (!email) {
    deps.err('login: --email is required');
    return 1;
  }
  let password = flagStr(flags, 'password');
  if (!password) {
    if (!deps.readPassword) {
      deps.err('login: --password is required');
      return 1;
    }
    password = await deps.readPassword('Password: ');
  }

  const client = deps.makeClient({ url: apiUrl });
  const session = await client.auth.signIn({ email, password });
  deps.saveConfig({ apiUrl, token: session.accessToken, email });
  deps.out(`Logged in as ${email}. Token saved to ${'~/.basefyio/config.json'}.`);
  return 0;
}

async function cmdProjects(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  deps: CommandDeps,
  apiUrl: string,
  config: CliConfig,
): Promise<number> {
  const token = requireToken(config, deps);
  if (!token) return 1;
  const client = deps.makeClient({ url: apiUrl, token });

  switch (sub) {
    case 'list': {
      deps.out(formatProjects(await client.projects.list()));
      return 0;
    }
    case 'create': {
      const name = flagStr(flags, 'name') ?? rest[0];
      const teamId = flagStr(flags, 'team');
      const region = flagStr(flags, 'region');
      if (!name) {
        deps.err('projects create: --name is required');
        return 1;
      }
      if (!teamId) {
        deps.err('projects create: --team <teamId> is required');
        return 1;
      }
      const project = await client.projects.create({ name, teamId, ...(region ? { region } : {}) });
      deps.out(`Created project ${project.name} (${project.id})`);
      return 0;
    }
    case 'get': {
      const id = rest[0] ?? flagStr(flags, 'id');
      if (!id) {
        deps.err('projects get: <id> is required');
        return 1;
      }
      deps.out(formatProject(await client.projects.get(id)));
      return 0;
    }
    default:
      deps.err(`Unknown subcommand: projects ${sub ?? ''}`.trim());
      return 1;
  }
}

async function cmdSql(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  deps: CommandDeps,
  apiUrl: string,
  config: CliConfig,
): Promise<number> {
  if (sub !== 'execute') {
    deps.err(`Unknown subcommand: sql ${sub ?? ''}`.trim());
    return 1;
  }
  const token = requireToken(config, deps);
  if (!token) return 1;

  const projectId = flagStr(flags, 'project') ?? rest[0];
  const query = flagStr(flags, 'query') ?? rest.slice(1).join(' ');
  if (!projectId || !query) {
    deps.err('sql execute: <projectId> and <query> are required');
    return 1;
  }
  const client = deps.makeClient({ url: apiUrl, token });
  const result = await client.withProject(projectId).sql.execute(query);
  deps.out(formatSqlResult(result));
  return 0;
}

async function cmdStorage(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
  deps: CommandDeps,
  apiUrl: string,
  config: CliConfig,
): Promise<number> {
  if (sub !== 'buckets') {
    deps.err(`Unknown subcommand: storage ${sub ?? ''}`.trim());
    return 1;
  }
  const token = requireToken(config, deps);
  if (!token) return 1;

  const action = rest[0];
  const projectId = flagStr(flags, 'project') ?? rest[1];
  if (!projectId) {
    deps.err('storage buckets: <projectId> is required');
    return 1;
  }
  const storage = deps.makeClient({ url: apiUrl, token }).withProject(projectId).storage;

  switch (action) {
    case 'list': {
      deps.out(formatBuckets(await storage.listBuckets()));
      return 0;
    }
    case 'create': {
      const name = flagStr(flags, 'name') ?? rest[2];
      if (!name) {
        deps.err('storage buckets create: <bucket> is required');
        return 1;
      }
      const bucket = await storage.createBucket({ name, public: flags.public === true });
      deps.out(`Created bucket ${bucket.name} (${bucket.public ? 'public' : 'private'})`);
      return 0;
    }
    case 'delete': {
      const name = flagStr(flags, 'name') ?? rest[2];
      if (!name) {
        deps.err('storage buckets delete: <bucket> is required');
        return 1;
      }
      await storage.deleteBucket(name);
      deps.out(`Deleted bucket ${name}`);
      return 0;
    }
    default:
      deps.err(`Unknown action: storage buckets ${action ?? ''}`.trim());
      return 1;
  }
}

/**
 * Dispatch an SDK-backed command. Returns a process exit code. All API access
 * goes through the injected PlatformClient (`@basefyio/sdk`) — no fetch here.
 */
export async function run(argv: string[], deps: CommandDeps): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const [group, sub, ...rest] = positionals;
  const config = deps.loadConfig();
  const apiUrl = flagStr(flags, 'url') ?? config.apiUrl ?? deps.defaultApiUrl;

  try {
    switch (group) {
      case 'login':
        return await cmdLogin(flags, deps, apiUrl);
      case 'projects':
        return await cmdProjects(sub, rest, flags, deps, apiUrl, config);
      case 'sql':
        return await cmdSql(sub, rest, flags, deps, apiUrl, config);
      case 'storage':
        return await cmdStorage(sub, rest, flags, deps, apiUrl, config);
      default:
        deps.err(`Unknown command: ${group ?? ''}`.trim());
        return 1;
    }
  } catch (err) {
    deps.err(`Error: ${errMessage(err)}`);
    return 1;
  }
}

/** Commands handled here (everything except version/doctor/help, which live in index). */
export const SDK_COMMANDS = ['login', 'projects', 'sql', 'storage'] as const;
