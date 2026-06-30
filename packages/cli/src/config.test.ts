import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, loadConfig, saveConfig } from './config';

describe('config store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'basefyio-cli-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns an empty object when no config exists', () => {
    expect(loadConfig(home)).toEqual({});
  });

  it('round-trips a saved config', () => {
    saveConfig({ apiUrl: 'http://localhost:4000', token: 'jwt', email: 'a@b.com' }, home);
    expect(loadConfig(home)).toEqual({
      apiUrl: 'http://localhost:4000',
      token: 'jwt',
      email: 'a@b.com',
    });
  });

  it('writes to <home>/.basefyio/config.json', () => {
    expect(configPath(home)).toBe(join(home, '.basefyio', 'config.json'));
  });

  it('tolerates malformed json', () => {
    saveConfig({ token: 'jwt' }, home);
    // Overwrite with junk and confirm we degrade to {}.
    writeFileSync(configPath(home), '{ not json');
    expect(loadConfig(home)).toEqual({});
  });
});
