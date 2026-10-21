// SqlService imports ProjectsService only for its type and DI token. Loading
// the real module here would drag in the Keycloak admin client (ESM), which
// this unit test neither needs nor can transform. The harness injects a mock.
jest.mock('../projects/projects.service', () => ({ ProjectsService: class {} }));

import { SqlService } from './sql.service';

/**
 * A key-authed SQL call runs under the key's role with the token published for
 * policies to read. Imported schemas define auth.uid() over the single-claim
 * key request.jwt.claim.sub, so that key has to be set alongside the JSON
 * claims or those policies deny every row. Same contract as the REST path.
 */
function harness() {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], fields: [], rowCount: 0 }),
    release: jest.fn(),
  };
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1',
        teamId: 't1',
        dbHost: 'h',
        dbPort: 5432,
        dbUser: 'u',
        dbPassword: 'secret',
        dbName: 'db',
      }),
    },
    teamMember: { findUnique: jest.fn().mockResolvedValue({ id: 'm1' }) },
    sqlAuditLog: { create: jest.fn().mockResolvedValue({ id: 'a1' }) },
  };
  const svc = new SqlService(
    prisma as any,
    {} as any,
    { append: jest.fn().mockResolvedValue(undefined) } as any,
    { enqueueJob: jest.fn() } as any,
    { ensureRlsBootstrap: jest.fn() } as any,
  );
  (svc as any).getPool = () => ({ connect: async () => client });
  return { svc, client };
}

const settings = (client: { query: jest.Mock }) =>
  client.query.mock.calls
    .filter(([sql]: [string]) => /set_config/.test(sql))
    .map(([sql, params]: [string, unknown[]]) =>
      /\$1, \$2/.test(sql) ? params : [sql.match(/'([^']+)'/)![1], params[0]],
    );

describe('SqlService.execute under an API key — claims published to policies', () => {
  it('publishes JSON claims, the role, and the single-claim keys', async () => {
    const { svc, client } = harness();
    const claims = { sub: 'user-1', email: 'u@example.com' };

    await svc.execute('p1', 'SELECT 1', undefined, {
      rls: { role: 'authenticated', jwtClaims: claims },
    });

    expect(settings(client)).toEqual([
      ['request.jwt.claims', JSON.stringify(claims)],
      ['request.jwt.role', 'authenticated'],
      ['request.jwt.claim.sub', 'user-1'],
      ['request.jwt.claim.role', 'authenticated'],
      ['request.jwt.claim.email', 'u@example.com'],
    ]);
  });

  it('publishes empty single claims for the anon role', async () => {
    const { svc, client } = harness();

    await svc.execute('p1', 'SELECT 1', undefined, { rls: { role: 'anon' } });

    expect(settings(client)).toEqual(
      expect.arrayContaining([
        ['request.jwt.claim.sub', ''],
        ['request.jwt.claim.role', 'anon'],
        ['request.jwt.claim.email', ''],
      ]),
    );
  });

  it('publishes nothing for a dashboard session, which runs as the owner', async () => {
    const { svc, client } = harness();

    await svc.execute('p1', 'SELECT 1', 'u1');

    expect(settings(client)).toEqual([]);
    expect(client.query.mock.calls.some(([sql]: [string]) => /SET LOCAL ROLE/.test(sql))).toBe(false);
  });
});
