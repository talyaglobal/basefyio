// ProjectsService reaches an ESM-only Keycloak client through its own imports,
// which Jest cannot load. Only its identity matters for construction here.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));

import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { PublicApiService } from './public-api.service';

/**
 * Who may call a SECURITY DEFINER function.
 *
 * `rpc` runs under the caller's Postgres role like the rest of the data plane,
 * which is what makes row-level policy apply to it. A function declared
 * SECURITY DEFINER breaks that: it executes as its owner — here the database
 * owner — and the owner is not subject to policy. So such a function is a hole
 * straight through RLS, and `prokind = 'f'` does not notice it, which left it
 * callable with the anon key that ships in every browser bundle.
 */
describe('PublicApiService.rpc — SECURITY DEFINER', () => {
  /**
   * A service whose only live part is rpc: withRls is replaced with a stub
   * client that answers the catalogue lookup with the given function shape.
   */
  function serviceReturning(fn: { definer: boolean; argnames?: string[] } | null) {
    const svc = new PublicApiService({} as any, { get: () => undefined } as any, {} as any, {} as any);
    clearInterval((svc as any).poolCleanupTimer);

    const client = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (/FROM pg_proc/.test(sql)) {
          return fn
            ? { rowCount: 1, rows: [{ signature: 'f()', definer: fn.definer, argnames: fn.argnames ?? [] }] }
            : { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [{ result: 'ran' }] };
      }),
    };
    jest
      .spyOn(svc as any, 'withRls')
      .mockImplementation((_p: any, _ctx: any, body: any) => body(client));
    return { svc, client };
  }

  const call = (svc: PublicApiService, role: 'anon' | 'authenticated' | 'service_role') =>
    svc.rpc('p1', 'secret_total', {}, { role } as any);

  it('refuses an anonymous caller', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'anon')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('says why, rather than reporting the function as missing', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'anon')).rejects.toThrow(/SECURITY DEFINER/);
  });

  it('never reaches the function body for an anonymous caller', async () => {
    const { svc, client } = serviceReturning({ definer: true });
    await expect(call(svc, 'anon')).rejects.toBeInstanceOf(ForbiddenException);
    const executed = client.query.mock.calls.filter(([sql]: [string]) => !/FROM pg_proc/.test(sql));
    expect(executed).toHaveLength(0);
  });

  it('allows a signed-in end user, whose identity the function can check', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'authenticated')).resolves.toBeDefined();
  });

  it('allows the service key, which is server-side and already bypasses policy', async () => {
    const { svc } = serviceReturning({ definer: true });
    await expect(call(svc, 'service_role')).resolves.toBeDefined();
  });

  it('leaves an ordinary invoker-rights function open to anyone, since policy still binds it', async () => {
    const { svc } = serviceReturning({ definer: false });
    await expect(call(svc, 'anon')).resolves.toBeDefined();
  });

  it('still reports a missing function as missing', async () => {
    const { svc } = serviceReturning(null);
    await expect(call(svc, 'anon')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a function name that is not an identifier before looking anything up', async () => {
    const { svc, client } = serviceReturning({ definer: false });
    await expect(svc.rpc('p1', 'drop; --', {}, { role: 'anon' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.query).not.toHaveBeenCalled();
  });
});
