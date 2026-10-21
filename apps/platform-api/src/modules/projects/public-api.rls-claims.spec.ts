// ProjectsService reaches an ESM-only Keycloak client through its own imports,
// which Jest cannot load. Only its identity matters for construction here.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));

import { PublicApiService } from './public-api.service';

/**
 * What a policy can see of the caller.
 *
 * The RLS transaction publishes the verified token under request.jwt.claims
 * and the role under request.jwt.role. Databases imported from elsewhere carry
 * an auth.uid() that reads request.jwt.claim.sub instead, so the transaction
 * must publish the single-claim keys as well or every such policy denies
 * everyone. These tests pin the full set of settings and their order.
 */
function serviceWithClient() {
  const svc = new PublicApiService({} as any, { get: () => undefined } as any, {} as any, {} as any);
  clearInterval((svc as any).poolCleanupTimer);

  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  jest.spyOn(svc as any, 'getPool').mockResolvedValue({ connect: async () => client });
  return { svc, client };
}

const settings = (client: { query: jest.Mock }) =>
  client.query.mock.calls
    .filter(([sql]: [string]) => /set_config/.test(sql))
    .map(([sql, params]: [string, unknown[]]) =>
      /\$1, \$2/.test(sql) ? params : [sql.match(/'([^']+)'/)![1], params[0]],
    );

describe('PublicApiService.runRlsTransaction — claims published to policies', () => {
  it('publishes the JSON claims, the role, and every single-claim key an imported helper reads', async () => {
    const { svc, client } = serviceWithClient();
    const claims = { sub: 'user-1', email: 'u@example.com', iss: 'kc' };

    await (svc as any).runRlsTransaction('p1', { role: 'authenticated', jwtClaims: claims }, async () => 'ok');

    expect(settings(client)).toEqual([
      ['request.jwt.claims', JSON.stringify(claims)],
      ['request.jwt.role', 'authenticated'],
      ['request.jwt.claim.sub', 'user-1'],
      ['request.jwt.claim.role', 'authenticated'],
      ['request.jwt.claim.email', 'u@example.com'],
    ]);
  });

  it('gives an anonymous request empty single claims, so nullif() makes auth.uid() NULL', async () => {
    const { svc, client } = serviceWithClient();

    await (svc as any).runRlsTransaction('p1', { role: 'anon' }, async () => 'ok');

    expect(settings(client)).toEqual([
      ['request.jwt.claims', '{}'],
      ['request.jwt.role', 'anon'],
      ['request.jwt.claim.sub', ''],
      ['request.jwt.claim.role', 'anon'],
      ['request.jwt.claim.email', ''],
    ]);
  });

  it('sets the role before any claim and commits after the body', async () => {
    const { svc, client } = serviceWithClient();
    await (svc as any).runRlsTransaction('p1', { role: 'authenticated', jwtClaims: { sub: 'x' } }, async () => 'ok');
    const sqls = client.query.mock.calls.map(([sql]: [string]) => sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toBe('SET LOCAL ROLE "authenticated"');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });
});
