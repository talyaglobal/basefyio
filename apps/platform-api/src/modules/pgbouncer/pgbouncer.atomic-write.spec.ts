import { join } from 'path';

jest.mock('fs/promises', () => ({
  access: jest.fn(),
  chmod: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
}));

// The reload opens a pooler connection; none exists in a unit test, and the
// real Pool would wait out its connection timeout before giving up.
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    connect: jest.fn().mockRejectedValue(new Error('no pooler in tests')),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { access, rename, writeFile } from 'fs/promises';
import { Logger } from '@nestjs/common';
import { PgBouncerService } from './pgbouncer.service';

const CONFIG_DIR = '/cfg';

const build = (projects: Array<{ dbName: string; dbUser: string; dbPassword: string }>) => {
  const prisma = { project: { findMany: jest.fn().mockResolvedValue(projects) } } as any;
  const config = { get: (key: string) => (key === 'pgbouncer.configDir' ? CONFIG_DIR : undefined) } as any;
  return new PgBouncerService(prisma, config);
};

/**
 * pgbouncer.ini and userlist.txt sit on a volume PgBouncer reads on RELOAD, and
 * a second API replica may regenerate them at the same moment. Neither reader
 * may ever see a truncated file, so each is written beside the live one and
 * renamed over it.
 */
describe('PgBouncerService — config files are replaced atomically', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    (access as jest.Mock).mockReset().mockResolvedValue(undefined);
    (writeFile as jest.Mock).mockReset().mockResolvedValue(undefined);
    (rename as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('writes a temporary file and renames it over the live one, for both files', async () => {
    await build([{ dbName: 'db_a', dbUser: 'u_a', dbPassword: 'pw' }]).regenerateConfig();

    const ini = join(CONFIG_DIR, 'pgbouncer.ini');
    const userlist = join(CONFIG_DIR, 'userlist.txt');

    const written = (writeFile as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(written).toHaveLength(2);
    expect(written).not.toContain(ini);
    expect(written).not.toContain(userlist);
    expect(written.every((p) => p.endsWith('.tmp'))).toBe(true);

    const renames = (rename as jest.Mock).mock.calls as Array<[string, string]>;
    expect(renames.map(([, to]) => to)).toEqual([ini, userlist]);
    for (const [from, to] of renames) {
      expect(from.startsWith(to)).toBe(true);
      expect(written).toContain(from);
    }
  });

  it('writes the content the live file is meant to receive', async () => {
    await build([{ dbName: 'db_a', dbUser: 'u_a', dbPassword: 'pw' }]).regenerateConfig();
    const [[, iniContent], [, userlistContent]] = (writeFile as jest.Mock).mock.calls;
    expect(iniContent).toMatch(/^db_a = host=postgres port=5432 dbname=db_a$/m);
    expect(userlistContent).toMatch(/^"u_a" "pw"$/m);
  });

  it('never renames when the temporary write fails, so the live file is untouched', async () => {
    (writeFile as jest.Mock).mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(build([]).regenerateConfig()).rejects.toThrow('ENOSPC');
    expect(rename).not.toHaveBeenCalled();
  });

  it('uses a distinct temporary name per write, so two writers cannot collide on it', async () => {
    await build([]).regenerateConfig();
    await build([]).regenerateConfig();
    const tmps = (writeFile as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(new Set(tmps).size).toBe(tmps.length);
  });
});
