import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { drainState } from '../../common/utils/drain-state';

/**
 * Readiness is what decides whether traffic comes here. It must say no while
 * the process is draining and while the platform database is unreachable,
 * and yes otherwise — even when a less essential dependency is down.
 */
function build(opts: { db?: 'ok' | 'failing'; redis?: 'ok' | 'failing' } = {}) {
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(() =>
      opts.db === 'failing' ? Promise.reject(new Error('connection refused')) : Promise.resolve([{ '?column?': 1 }]),
    ),
  };
  const redis = {
    getClient: () => ({
      ping: jest.fn().mockImplementation(() =>
        opts.redis === 'failing' ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve('PONG'),
      ),
    }),
  };
  // No Keycloak or MinIO configured: those checks report "skipped".
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const health = new HealthService(prisma as any, redis as any, config as any, undefined);
  const email = { getDeliverability: () => ({ state: 'ok' as const }) };
  const leader = { getInstanceId: () => 'i-1', getRole: () => 'leader' };
  const controller = new HealthController(email as any, leader as any, health);
  const res = () => {
    const r: any = { statusCode: 200, body: undefined };
    r.status = (code: number) => ((r.statusCode = code), r);
    r.json = (body: unknown) => ((r.body = body), r);
    return r;
  };
  return { controller, res };
}

describe('HealthController', () => {
  afterEach(() => drainState.reset());

  it('is ready when the database answers', async () => {
    const { controller, res } = build();
    const r = res();
    await controller.ready(r);
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ ready: true });
  });

  it('is not ready while draining, before anything else is asked', async () => {
    const { controller, res } = build({ db: 'ok' });
    drainState.start();
    const r = res();
    await controller.ready(r);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ ready: false, reason: 'draining' });
  });

  it('is not ready when the platform database does not answer', async () => {
    const { controller, res } = build({ db: 'failing' });
    const r = res();
    await controller.ready(r);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ ready: false, reason: 'database' });
  });

  it('stays ready when only Redis is down — a partial outage must not become a total one', async () => {
    const { controller, res } = build({ redis: 'failing' });
    const r = res();
    await controller.ready(r);
    expect(r.statusCode).toBe(200);
  });

  it('reports every dependency on the liveness route and degrades without failing it', async () => {
    const { controller } = build({ redis: 'failing' });
    const body = await controller.check();
    expect(body.status).toBe('degraded');
    expect(body.checks.database.state).toBe('ok');
    expect(body.checks.redis.state).toBe('failing');
    expect(body.checks.keycloak.state).toBe('skipped');
    expect(body.checks.storage.state).toBe('skipped');
    expect(body.checks.documentStore.state).toBe('skipped');
    expect(body.instance.id).toBe('i-1');
  });

  it('says it is draining on the liveness route too', async () => {
    const { controller } = build();
    drainState.start();
    const body = await controller.check();
    expect(body.draining).toBe(true);
  });
});
