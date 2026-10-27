import { HealthService } from './health.service';

/**
 * A dependency check must never take longer than its timeout, whatever the
 * dependency does: a hung Postgres or a black-holed HTTP probe would
 * otherwise hang the health route and, with it, the proxy's view of the API.
 */
describe('HealthService', () => {
  it('reports a hung database as failing within the timeout', async () => {
    const prisma = { $queryRaw: () => new Promise(() => undefined) }; // never resolves
    const redis = { getClient: () => ({ ping: async () => 'PONG' }) };
    const config = { get: () => undefined };
    const svc = new HealthService(prisma as any, redis as any, config as any, undefined);

    const started = Date.now();
    const out = await svc.database();

    expect(out.state).toBe('failing');
    expect(out.detail).toMatch(/no answer within/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('skips Keycloak and storage when they are not configured', async () => {
    const prisma = { $queryRaw: async () => [] };
    const redis = { getClient: () => ({ ping: async () => 'PONG' }) };
    const config = { get: () => undefined };
    const svc = new HealthService(prisma as any, redis as any, config as any, undefined);

    const all = await svc.all();

    expect(all.database.state).toBe('ok');
    expect(all.redis.state).toBe('ok');
    expect(all.keycloak.state).toBe('skipped');
    expect(all.storage.state).toBe('skipped');
    expect(all.documentStore.state).toBe('skipped');
  });

  it('treats a non-200 from a dependency probe as failing, with the status in the detail', async () => {
    const prisma = { $queryRaw: async () => [] };
    const redis = { getClient: () => ({ ping: async () => 'PONG' }) };
    const config = { get: (key: string) => (key === 'keycloak.url' ? 'http://keycloak:8080/' : undefined) };
    const svc = new HealthService(prisma as any, redis as any, config as any, undefined);
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch' as any)
      .mockResolvedValue({ status: 503 } as any);

    const out = await svc.keycloak();

    expect(fetchSpy).toHaveBeenCalledWith('http://keycloak:8080/health/ready', expect.anything());
    expect(out).toMatchObject({ state: 'failing', detail: 'HTTP 503' });
    fetchSpy.mockRestore();
  });

  it('probes KEYCLOAK_HEALTH_URL when it is set (Keycloak 25+ serves health on the management port)', async () => {
    const prisma = { $queryRaw: async () => [] };
    const redis = { getClient: () => ({ ping: async () => 'PONG' }) };
    const values: Record<string, string> = {
      'keycloak.url': 'http://keycloak:8080',
      'keycloak.healthUrl': 'http://keycloak:9000/health/ready',
    };
    const config = { get: (key: string) => values[key] };
    const svc = new HealthService(prisma as any, redis as any, config as any, undefined);
    const fetchSpy = jest.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ status: 200 } as any);

    const out = await svc.keycloak();

    expect(fetchSpy).toHaveBeenCalledWith('http://keycloak:9000/health/ready', expect.anything());
    expect(out.state).toBe('ok');
    fetchSpy.mockRestore();
  });

  it('reports the document store through its own ping', async () => {
    const prisma = { $queryRaw: async () => [] };
    const redis = { getClient: () => ({ ping: async () => 'PONG' }) };
    const config = { get: () => undefined };
    const engine = { ping: async () => false };
    const svc = new HealthService(prisma as any, redis as any, config as any, engine as any);

    expect((await svc.documentStore()).state).toBe('failing');
  });
});
