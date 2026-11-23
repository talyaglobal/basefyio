import Conf from 'conf';
import path from 'path';
import fs from 'fs/promises';

export interface UserConfig {
  apiUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  userId?: string;
  username?: string;
  email?: string;
}

export interface ProjectConfig {
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  teamId?: string;
  linkedAt?: string;
}

const userConfig = new Conf<UserConfig>({
  projectName: 'basefyio',
  configName: 'config',
});

// Get current project directory
export async function getProjectRoot(): Promise<string | null> {
  let currentDir = process.cwd();
  
  while (currentDir !== path.parse(currentDir).root) {
    const configPath = path.join(currentDir, '.basefyio');
    try {
      await fs.access(configPath);
      return currentDir;
    } catch {
      currentDir = path.dirname(currentDir);
    }
  }
  
  return null;
}

// Project-specific configuration
export async function getProjectConfig(): Promise<ProjectConfig | null> {
  const projectRoot = await getProjectRoot();
  if (!projectRoot) return null;

  const configPath = path.join(projectRoot, '.basefyio', 'config.json');
  
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function setProjectConfig(config: ProjectConfig): Promise<void> {
  const projectRoot = process.cwd();
  const configDir = path.join(projectRoot, '.basefyio');
  const configPath = path.join(configDir, 'config.json');

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

// User configuration helpers
export function getUserConfig(): UserConfig {
  return userConfig.store;
}

export function setUserConfig(config: Partial<UserConfig>): void {
  userConfig.set(config);
}

export function clearUserConfig(): void {
  userConfig.clear();
}

export const DEFAULT_API_URL = 'https://api.basefyio.com';

export function getApiUrl(): string {
  return userConfig.get('apiUrl') || DEFAULT_API_URL;
}

export function getAccessToken(): string | undefined {
  return userConfig.get('accessToken');
}

/**
 * Persist the access token. Refuses empty/undefined values so a malformed
 * refresh response can't silently delete the user's session — the previous
 * behaviour ("setAccessToken(undefined)" via conf.set) erased the stored
 * token and forced an immediate re-login on the next command. See the
 * `basefyio status` re-login loop incident.
 */
export function setAccessToken(token: string | undefined | null): void {
  if (!token || typeof token !== 'string') return;
  userConfig.set('accessToken', token);
}

export function getRefreshToken(): string | undefined {
  return userConfig.get('refreshToken');
}

/** Same guard as setAccessToken — see comment there. */
export function setRefreshToken(token: string | undefined | null): void {
  if (!token || typeof token !== 'string') return;
  userConfig.set('refreshToken', token);
}

/** Clear both tokens — used when refresh has definitively failed and we
 *  truly need the user to log in again. Never clear from anywhere else. */
export function clearAuthTokens(): void {
  userConfig.delete('accessToken');
  userConfig.delete('refreshToken');
}

export function isLoggedIn(): boolean {
  return !!userConfig.get('accessToken');
}

export function setApiUrl(url: string): void {
  userConfig.set('apiUrl', url);
}

/** The credentials `writeEnvFile` can use (from `POST /api/projects/:id/secrets/reveal`). */
export interface EnvSecrets {
  password?: string | null;
  uri?: string | null;
  poolerUri?: string | null;
  serviceKey?: string | null;
}

/** A masked URI from `GET connect` still holds this instead of the password. */
const PASSWORD_PLACEHOLDER = '[YOUR-PASSWORD]';

/**
 * The basefyio variables for `.env`. The general project read carries no password or service
 * key (#14): they come from `secrets` (the reveal endpoint) or, right after `basefyio init`,
 * from the creation response. A variable whose value is unknown is left out, so an existing
 * line in `.env` is kept as it is; the names are returned in `missing`.
 */
export function buildEnvVars(
  project: any,
  apiUrl: string,
  connect?: { poolerUri: string; uri: string; poolerHost?: string; poolerPort?: number; host?: string; port?: number; user?: string; database?: string },
  secrets?: EnvSecrets | null,
): { vars: Record<string, string>; missing: string[] } {
  const password = secrets?.password ?? project.dbPassword ?? null;
  const usable = (uri?: string | null) => (uri && !uri.includes(PASSWORD_PLACEHOLDER) ? uri : null);
  const withPassword = (uri?: string | null) =>
    uri && password ? uri.replace(PASSWORD_PLACEHOLDER, encodeURIComponent(password)) : null;
  const fallbackDbUrl = password
    ? `postgresql://${encodeURIComponent(project.dbUser)}:${encodeURIComponent(password)}@${project.dbHost}:${project.dbPort}/${project.dbName}`
    : null;
  const databaseUrl =
    usable(secrets?.poolerUri) ?? usable(connect?.poolerUri) ?? withPassword(connect?.poolerUri) ?? fallbackDbUrl;
  const directUrl = usable(secrets?.uri) ?? usable(connect?.uri) ?? withPassword(connect?.uri) ?? databaseUrl;
  const serviceKey = secrets?.serviceKey ?? project.serviceKey ?? null;

  const all: Record<string, string | null> = {
    BASEFYIO_PROJECT_ID: project.id,
    BASEFYIO_ANON_KEY: project.anonKey,
    BASEFYIO_SERVICE_KEY: serviceKey,
    BASEFYIO_API_URL: apiUrl,
    BASEFYIO_PROJECT_SLUG: project.slug,
    BASEFYIO_DB_HOST: project.dbHost,
    BASEFYIO_DB_PORT: String(project.dbPort),
    BASEFYIO_DB_NAME: project.dbName,
    BASEFYIO_DB_USER: project.dbUser,
    BASEFYIO_DB_PASSWORD: password,
    BASEFYIO_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    BASEFYIO_KEYCLOAK_REALM: project.keycloakRealm,
  };
  const vars: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (value == null || value === '') missing.push(key);
    else vars[key] = value;
  }
  return { vars, missing };
}

/** What to tell the user about variables `writeEnvFile` had no value for. */
export function missingEnvHint(missing: string[]): string | null {
  if (missing.length === 0) return null;
  const parts: string[] = [];
  if (missing.includes('BASEFYIO_DB_PASSWORD')) {
    parts.push(
      'the database password is hidden from your role: ask a team owner or admin, or copy it from the dashboard Connection page',
    );
  }
  if (missing.includes('BASEFYIO_SERVICE_KEY')) {
    parts.push(
      'the service key is in use, so it is no longer shown: rotate it or create a secret key under Connection → API keys',
    );
  }
  return `Not written to .env: ${missing.join(', ')}${parts.length ? ` — ${parts.join('; ')}` : ''}`;
}

// Write basefyio variables into .env without touching existing content.
// Existing BASEFYIO_* keys are updated in-place; new ones are appended.
// Returns the variables that could not be written (no credential available).
export async function writeEnvFile(
  project: any,
  connect?: { poolerUri: string; uri: string },
  secrets?: EnvSecrets | null,
): Promise<string[]> {
  const apiUrl = getApiUrl();
  const { vars: basefyioVars, missing } = buildEnvVars(project, apiUrl, connect, secrets);

  // Read existing .env (or start empty)
  let existing = '';
  try { existing = await fs.readFile('.env', 'utf-8'); } catch { /* new file */ }

  const existingLines = existing.split('\n');
  const handled = new Set<string>();

  // Update existing BASEFYIO_* lines in-place
  const updatedLines = existingLines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (match && basefyioVars[match[1]] !== undefined) {
      handled.add(match[1]);
      return `${match[1]}=${basefyioVars[match[1]]}`;
    }
    return line;
  });

  // Remove trailing empty lines before appending
  while (updatedLines.length && updatedLines[updatedLines.length - 1].trim() === '') {
    updatedLines.pop();
  }

  // Append any new keys not already present
  const newKeys = Object.keys(basefyioVars).filter((k) => !handled.has(k));
  if (newKeys.length) {
    updatedLines.push('');
    updatedLines.push('# basefyio — added by "basefyio init" / "basefyio link"');
    for (const key of newKeys) {
      updatedLines.push(`${key}=${basefyioVars[key]}`);
    }
  }

  updatedLines.push('');
  await fs.writeFile('.env', updatedLines.join('\n'));

  // Make sure .gitignore has .env
  try {
    let gi = '';
    try { gi = await fs.readFile('.gitignore', 'utf-8'); } catch { /* noop */ }
    if (!gi.includes('.env')) {
      await fs.writeFile('.gitignore', gi + '\n.env\n');
    }
  } catch { /* best-effort */ }
  return missing;
}

// Local .env management
export async function getLocalEnv(): Promise<Record<string, string>> {
  const projectRoot = await getProjectRoot();
  if (!projectRoot) return {};

  const envPath = path.join(projectRoot, '.env');
  
  try {
    const content = await fs.readFile(envPath, 'utf-8');
    const env: Record<string, string> = {};
    
    content.split('\n').forEach(line => {
      line = line.trim();
      if (!line || line.startsWith('#')) return;
      
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join('=').trim();
      }
    });
    
    return env;
  } catch {
    return {};
  }
}

export async function setLocalEnv(key: string, value: string): Promise<void> {
  const projectRoot = await getProjectRoot();
  if (!projectRoot) {
    throw new Error('Not in a basefyio project directory');
  }

  const envPath = path.join(projectRoot, '.env');
  let content = '';
  
  try {
    content = await fs.readFile(envPath, 'utf-8');
  } catch {
    // File doesn't exist, will create new
  }

  const lines = content.split('\n');
  let found = false;
  
  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    newLines.push(`${key}=${value}`);
  }

  await fs.writeFile(envPath, newLines.join('\n'));
}

export async function unsetLocalEnv(key: string): Promise<void> {
  const projectRoot = await getProjectRoot();
  if (!projectRoot) {
    throw new Error('Not in a basefyio project directory');
  }

  const envPath = path.join(projectRoot, '.env');
  
  try {
    const content = await fs.readFile(envPath, 'utf-8');
    const lines = content.split('\n').filter(line => {
      const trimmed = line.trim();
      return !trimmed.startsWith(`${key}=`);
    });
    
    await fs.writeFile(envPath, lines.join('\n'));
  } catch {
    // File doesn't exist, nothing to do
  }
}
