import { ForbiddenException, Logger } from '@nestjs/common';

const pools: any[] = [];
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((opts: unknown) => {
    const client = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })), release: jest.fn() };
    const pool = {
      opts,
      client,
      connect: jest.fn(async () => client),
      end: jest.fn(async () => undefined),
      on: jest.fn(),
    };
    pools.push(pool);
    return pool;
  }),
}));

import { ProjectRlsRunner } from './project-rls-runner';

const PROJECT = {
  dbHost: 'db.internal',
  dbPort: 5432,
  dbUser: 'kb_user_a',
  dbPassword: 'pw',
  dbName: 'kb_a',
};

function build(found: unknown = PROJECT) {
  const prisma = { project: { findFirst: jest.fn().mockResolvedValue(found) } };
  const runner = new ProjectRlsRunner(prisma as any);
  return { prisma, runner };
}

const sqlOf = (pool: any) => pool.client.query.mock.calls.map(([sql]: [string]) => sql.trim());

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
beforeEach(() => {
  pools.length = 0;
});

describe('ProjectRlsRunner.runRlsTransaction', () => {
  it('drops to the role, publishes the claims, runs the body and commits', async () => {
    const { runner } = build();
    const body = jest.fn(async () => 'answer');
    const out = await runner.runRlsTransaction(
      'p1',
      { role: 'authenticated', jwtClaims: { sub: 'alice', email: 'a@x.io' } },
      body,
    );
    expect(out).toBe('answer');
    const sql = sqlOf(pools[0]);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toBe('SET LOCAL ROLE "authenticated"');
    expect(sql[2]).toContain(`set_config('request.jwt.claims'`);
    expect(pools[0].client.query.mock.calls[2][1]).toEqual([JSON.stringify({ sub: 'alice', email: 'a@x.io' })]);
    expect(sql[3]).toContain(`set_config('request.jwt.role'`);
    expect(sql.at(-1)).toBe('COMMIT');
    expect(body).toHaveBeenCalledWith(pools[0].client);
    expect(pools[0].client.release).toHaveBeenCalled();
  });

  it('rolls back a dry run even when the body succeeded', async () => {
    const { runner } = build();
    await runner.runRlsTransaction('p1', { role: 'anon' }, async () => 1, { dryRun: true });
    const sql = sqlOf(pools[0]);
    expect(sql.at(-1)).toBe('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });

  it('rolls back and rethrows when the body fails', async () => {
    const { runner } = build();
    const boom = Object.assign(new Error('denied'), { code: '42501' });
    await expect(
      runner.runRlsTransaction('p1', { role: 'anon' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(sqlOf(pools[0]).at(-1)).toBe('ROLLBACK');
    expect(pools[0].client.release).toHaveBeenCalled();
  });

  it('tags a SET ROLE failure so callers can tell it from a policy denial', async () => {
    const { runner } = build();
    pools.length = 0;
    const roleErr = Object.assign(new Error('permission denied to set role'), { code: '42501' });
    // First call creates the pool; make its client refuse SET ROLE.
    const p = runner.runRlsTransaction('p1', { role: 'anon' }, async () => 1);
    await Promise.resolve();
    pools[0].client.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SET LOCAL ROLE')) throw roleErr;
      return { rows: [] };
    });
    await expect(p).rejects.toMatchObject({ __setRoleFailed: true });
  });

  it('refuses a role outside anon / authenticated / service_role', async () => {
    const { runner } = build();
    await expect(
      runner.runRlsTransaction('p1', { role: 'postgres' as any }, async () => 1),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(pools).toHaveLength(0);
  });
});

describe('ProjectRlsRunner pools', () => {
  it('connects with the project credentials, capped at five connections, and reuses the pool', async () => {
    const { runner, prisma } = build();
    await runner.runAsOwner('p1', async () => 1);
    await runner.runAsOwner('p1', async () => 2);
    expect(pools).toHaveLength(1);
    expect(pools[0].opts).toMatchObject({ host: 'db.internal', user: 'kb_user_a', database: 'kb_a', max: 5 });
    expect(prisma.project.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.project.findFirst.mock.calls[0][0].where).toEqual({ id: 'p1', status: 'ACTIVE' });
  });

  it('runAsOwner never changes role', async () => {
    const { runner } = build();
    await runner.runAsOwner('p1', (c) => c.query('SELECT 1'));
    expect(sqlOf(pools[0])).toEqual(['SELECT 1']);
    expect(pools[0].client.release).toHaveBeenCalled();
  });

  it('refuses a project that is missing or not active', async () => {
    const { runner } = build(null);
    await expect(runner.runAsOwner('gone', async () => 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dropPool ends and forgets the pool', async () => {
    const { runner } = build();
    await runner.runAsOwner('p1', async () => 1);
    await runner.dropPool('p1');
    expect(pools[0].end).toHaveBeenCalled();
    await runner.runAsOwner('p1', async () => 1);
    expect(pools).toHaveLength(2);
  });

  it('closes every pool on shutdown', async () => {
    const { runner } = build();
    await runner.runAsOwner('p1', async () => 1);
    await runner.onModuleDestroy();
    expect(pools[0].end).toHaveBeenCalled();
  });
});
