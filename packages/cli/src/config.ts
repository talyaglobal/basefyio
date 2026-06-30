import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Persisted CLI state. Token is a platform JWT obtained via `basefyio login`. */
export interface CliConfig {
  apiUrl?: string;
  token?: string;
  email?: string;
}

/** Directory holding the CLI config (overridable for tests). */
export function configDir(home: string = homedir()): string {
  return join(home, '.basefyio');
}

export function configPath(home?: string): string {
  return join(configDir(home), 'config.json');
}

/** Load config; returns an empty object when the file is missing or unreadable. */
export function loadConfig(home?: string): CliConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(home), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CliConfig) : {};
  } catch {
    return {};
  }
}

/** Persist config as pretty JSON. File is mode 0600 — it holds an access token. */
export function saveConfig(config: CliConfig, home?: string): void {
  mkdirSync(configDir(home), { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}
