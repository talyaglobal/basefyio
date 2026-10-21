const clientQuery = jest.fn();
const poolConnect = jest.fn();
const poolEnd = jest.fn();
const poolCtor = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((opts: unknown) => {
    poolCtor(opts);
    return {
      connect: poolConnect,
      end: poolEnd,
    };
  }),
}));

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_EXTENSIONS,
  ProjectProvisioningService,
  parseStatements,
} from './project-provisioning.service';

const target = { host: 'postgres', port: 5432, user: 'admin', password: 'pw', dbName: 'kb_abc' };

function service(cfg: Record<string, unknown> = {}, prisma: any = {}) {
  const config = { get: (k: string) => cfg[k] };
  return new ProjectProvisioningService(prisma, config as any);
}

/** A client whose CREATE EXTENSION statements succeed unless listed in `failing`. */
function connectWith(failing: Record<string, string> = {}, present: string[] = []) {
  const release = jest.fn();
  clientQuery.mockImplementation(async (sql: string) => {
    if (/FROM pg_extension/.test(sql)) {
      return { rows: present.map((extname) => ({ extname })) };
    }
    for (const [needle, message] of Object.entries(failing)) {
      if (sql.includes(needle)) throw new Error(message);
    }
    return { rows: [] };
  });
  poolConnect.mockResolvedValue({ query: clientQuery, release });
  return { release };
}

beforeEach(() => {
  clientQuery.mockReset();
  poolConnect.mockReset();
  poolEnd.mockReset().mockResolvedValue(undefined);
  poolCtor.mockReset();
});

describe('parseStatements', () => {
  it('drops comments and blank lines, strips one trailing semicolon, keeps a one-line DO block whole', () => {
    const out = parseStatements([
      '-- a comment',
      '',
      'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
      '   ',
      "DO $$ BEGIN IF current_setting('x') ~ 'y' THEN CREATE EXTENSION IF NOT EXISTS z; END IF; END $$;",
    ].join('\n'));
    expect(out).toEqual([
      'CREATE EXTENSION IF NOT EXISTS pg_trgm',
      "DO $$ BEGIN IF current_setting('x') ~ 'y' THEN CREATE EXTENSION IF NOT EXISTS z; END IF; END $$",
    ]);
  });
});

describe('the shipped default-extensions.sql', () => {
  it('names every extension in DEFAULT_EXTENSIONS, one statement each', () => {
    const statements = service().statements();
    expect(statements).toHaveLength(DEFAULT_EXTENSIONS.length);
    for (const name of DEFAULT_EXTENSIONS) {
      const re = new RegExp(`CREATE EXTENSION IF NOT EXISTS "?${name}"?`);
      expect(statements.some((s) => re.test(s))).toBe(true);
    }
  });

  it('creates pg_stat_statements only behind a preload check', () => {
    const stmt = service().statements().find((s) => s.includes('pg_stat_statements'))!;
    expect(stmt.startsWith('DO $$')).toBe(true);
    expect(stmt).toContain("current_setting('shared_preload_libraries')");
  });
});

describe('installDefaultExtensions', () => {
  it('runs every statement on its own and reports what is present afterwards', async () => {
    connectWith({}, ['plpgsql', 'pg_trgm', 'vector']);
    const result = await service().installDefaultExtensions(target);
    const creates = clientQuery.mock.calls.filter(([sql]) => !/FROM pg_extension/.test(sql));
    expect(creates).toHaveLength(DEFAULT_EXTENSIONS.length);
    expect(result.installed).toEqual(['pg_trgm', 'vector']);
    expect(result.skipped).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('skips a statement the cluster refuses and still runs the rest', async () => {
    connectWith({ vector: 'could not open extension control file' }, ['pg_trgm']);
    const result = await service().installDefaultExtensions(target);
    expect(result.skipped).toEqual([
      expect.objectContaining({ statement: expect.stringContaining('vector'), error: 'could not open extension control file' }),
    ]);
    // The pg_stat_statements block comes after vector and still ran.
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('pg_stat_statements'))).toBe(true);
    expect(result.installed).toEqual(['pg_trgm']);
  });

  it('resolves with an error instead of throwing when the database is unreachable', async () => {
    poolConnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await service().installDefaultExtensions(target);
    expect(result).toEqual({ installed: [], skipped: [], error: 'ECONNREFUSED' });
    expect(poolEnd).toHaveBeenCalled();
  });

  it('does nothing when PROVISION_DEFAULT_EXTENSIONS is off, unless forced', async () => {
    connectWith({}, ['pg_trgm']);
    const svc = service({ 'provisioning.defaultExtensions': false });
    expect(await svc.installDefaultExtensions(target)).toEqual({ installed: [], skipped: [] });
    expect(poolCtor).not.toHaveBeenCalled();
    const forced = await svc.installDefaultExtensions(target, { force: true });
    expect(forced.installed).toEqual(['pg_trgm']);
  });

  it('refuses an unsafe database identifier without opening a connection', async () => {
    const result = await service().installDefaultExtensions({ ...target, dbName: 'kb_x"; DROP' });
    expect(result.error).toMatch(/identifier/);
    expect(poolCtor).not.toHaveBeenCalled();
  });

  it('opens a single short-lived admin connection to the project database and closes it', async () => {
    connectWith();
    await service().installDefaultExtensions(target);
    expect(poolCtor).toHaveBeenCalledWith(
      expect.objectContaining({ database: 'kb_abc', user: 'admin', max: 1 }),
    );
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });
});

describe('installDefaultExtensionsForProject', () => {
  const sharedCfg = {
    'database.host': 'postgres',
    'database.port': 5432,
    'database.user': 'admin',
    'database.password': 'pw',
  };

  it('refuses a caller who is not a team member', async () => {
    const prisma = {
      project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1', dbName: 'kb_p1', dbHost: 'postgres', dbPort: 5432 }) },
      teamMember: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    await expect(service(sharedCfg, prisma).installDefaultExtensionsForProject('p1', 'u1'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the platform admin on the shared cluster and forces the install', async () => {
    connectWith({}, ['pgcrypto']);
    const prisma = {
      project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1', dbName: 'kb_p1', dbHost: 'postgres', dbPort: 5432, infrastructure: null }) },
      teamMember: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
    };
    const result = await service({ ...sharedCfg, 'provisioning.defaultExtensions': false }, prisma)
      .installDefaultExtensionsForProject('p1', 'u1');
    expect(result.installed).toEqual(['pgcrypto']);
    expect(poolCtor).toHaveBeenCalledWith(expect.objectContaining({ host: 'postgres', user: 'admin', database: 'kb_p1' }));
  });

  it('uses the recorded container admin on a dedicated host, and refuses without one', async () => {
    connectWith();
    const withCreds = {
      project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1', dbName: 'kb_p1', dbHost: '10.0.0.9', dbPort: 5433, infrastructure: { pgAdminUser: 'root', pgAdminPassword: 'secret' } }) },
      teamMember: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
    };
    await service(sharedCfg, withCreds).installDefaultExtensionsForProject('p1', 'u1');
    expect(poolCtor).toHaveBeenCalledWith(expect.objectContaining({ host: '10.0.0.9', port: 5433, user: 'root' }));

    const without = {
      project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1', dbName: 'kb_p1', dbHost: '10.0.0.9', dbPort: 5433, infrastructure: null }) },
      teamMember: { findUnique: jest.fn().mockResolvedValue({ userId: 'u1' }) },
    };
    await expect(service(sharedCfg, without).installDefaultExtensionsForProject('p1', 'u1'))
      .rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
