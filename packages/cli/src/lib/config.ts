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
  projectName: 'kolaybase',
  configName: 'config',
});

// Get current project directory
export async function getProjectRoot(): Promise<string | null> {
  let currentDir = process.cwd();
  
  while (currentDir !== path.parse(currentDir).root) {
    const configPath = path.join(currentDir, '.kolaybase');
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

  const configPath = path.join(projectRoot, '.kolaybase', 'config.json');
  
  try {
    const data = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function setProjectConfig(config: ProjectConfig): Promise<void> {
  const projectRoot = process.cwd();
  const configDir = path.join(projectRoot, '.kolaybase');
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

export const DEFAULT_API_URL = 'https://api.kolaybase.com';

export function getApiUrl(): string {
  return userConfig.get('apiUrl') || DEFAULT_API_URL;
}

export function getAccessToken(): string | undefined {
  return userConfig.get('accessToken');
}

export function setAccessToken(token: string): void {
  userConfig.set('accessToken', token);
}

export function getRefreshToken(): string | undefined {
  return userConfig.get('refreshToken');
}

export function setRefreshToken(token: string): void {
  userConfig.set('refreshToken', token);
}

export function isLoggedIn(): boolean {
  return !!userConfig.get('accessToken');
}

export function setApiUrl(url: string): void {
  userConfig.set('apiUrl', url);
}

// Write Kolaybase variables into .env without touching existing content.
// Existing KOLAYBASE_* keys are updated in-place; new ones are appended.
export async function writeEnvFile(
  project: any,
  connect?: { poolerUri: string; uri: string },
): Promise<void> {
  const apiUrl = getApiUrl();

  const fallbackDbUrl = `postgresql://${project.dbUser}:${project.dbPassword}@${project.dbHost}:${project.dbPort}/${project.dbName}`;
  const databaseUrl = connect?.poolerUri || fallbackDbUrl;
  const directUrl = connect?.uri || databaseUrl;

  const kolaybaseVars: Record<string, string> = {
    KOLAYBASE_PROJECT_ID: project.id,
    KOLAYBASE_ANON_KEY: project.anonKey,
    KOLAYBASE_SERVICE_KEY: project.serviceKey,
    KOLAYBASE_API_URL: apiUrl,
    KOLAYBASE_PROJECT_SLUG: project.slug,
    KOLAYBASE_DB_HOST: project.dbHost,
    KOLAYBASE_DB_PORT: String(project.dbPort),
    KOLAYBASE_DB_NAME: project.dbName,
    KOLAYBASE_DB_USER: project.dbUser,
    KOLAYBASE_DB_PASSWORD: project.dbPassword,
    KOLAYBASE_DATABASE_URL: databaseUrl,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: directUrl,
    KOLAYBASE_KEYCLOAK_REALM: project.keycloakRealm,
  };

  // Read existing .env (or start empty)
  let existing = '';
  try { existing = await fs.readFile('.env', 'utf-8'); } catch { /* new file */ }

  const existingLines = existing.split('\n');
  const handled = new Set<string>();

  // Update existing KOLAYBASE_* lines in-place
  const updatedLines = existingLines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (match && kolaybaseVars[match[1]] !== undefined) {
      handled.add(match[1]);
      return `${match[1]}=${kolaybaseVars[match[1]]}`;
    }
    return line;
  });

  // Remove trailing empty lines before appending
  while (updatedLines.length && updatedLines[updatedLines.length - 1].trim() === '') {
    updatedLines.pop();
  }

  // Append any new keys not already present
  const newKeys = Object.keys(kolaybaseVars).filter((k) => !handled.has(k));
  if (newKeys.length) {
    updatedLines.push('');
    updatedLines.push('# Kolaybase — added by "kb init" / "kb link"');
    for (const key of newKeys) {
      updatedLines.push(`${key}=${kolaybaseVars[key]}`);
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
    throw new Error('Not in a Kolaybase project directory');
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
    throw new Error('Not in a Kolaybase project directory');
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
