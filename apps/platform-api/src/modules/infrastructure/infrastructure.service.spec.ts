import { InfrastructureService } from './infrastructure.service';

/**
 * The Engine API is reached through the docker-proxy sidecar in the default
 * deployment. These run the service against a fake client to pin down the
 * calls it makes (the proxy allow-list is derived from them) and how it
 * behaves when the proxy is late or refuses a call.
 */

function httpError(statusCode: number, message = `HTTP ${statusCode}`) {
  return Object.assign(new Error(message), { statusCode });
}

function fakeDocker() {
  const containers = new Map<string, any>();
  const container = (name: string) => {
    if (!containers.has(name)) {
      containers.set(name, {
        inspect: jest.fn(async () => ({ State: { Status: 'running', Health: { Status: 'healthy' } } })),
        start: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
        remove: jest.fn(async () => undefined),
      });
    }
    return containers.get(name);
  };
  const volume = { remove: jest.fn(async () => undefined) };
  return {
    containers,
    container,
    volume,
    client: {
      ping: jest.fn(async () => 'OK'),
      createVolume: jest.fn(async () => ({})),
      createContainer: jest.fn(async (opts: any) => container(opts.name)),
      getContainer: jest.fn((name: string) => container(name)),
      getVolume: jest.fn(() => volume),
    },
  };
}

function makeService(docker: any, prisma: any = {}, env: Record<string, any> = {}) {
  const values: Record<string, any> = {
    'docker.host': 'tcp://docker-proxy:2375',
    'docker.socketPath': '/var/run/docker.sock',
    'docker.network': 'kolaybase_internal',
    'docker.pgImage': 'pg-image',
    'docker.minioImage': 'minio-image',
    'docker.labelPrefix': 'com.kolaybase',
    ...env,
  };
  const config = { get: (k: string) => values[k] } as any;
  const seen: any[] = [];
  class TestService extends InfrastructureService {
    protected retryDelayMs = 1;
    protected createClient(conn: any): any {
      seen.push(conn);
      return docker;
    }
  }
  const prismaDefaults = {
    projectInfrastructure: { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
    teamInfrastructure: { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})), upsert: jest.fn() },
  };
  const svc = new TestService(config, { ...prismaDefaults, ...prisma } as any);
  return { svc, seen, prisma: { ...prismaDefaults, ...prisma } };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('InfrastructureService against a fake Engine API', () => {
  it('connects through the proxy address from DOCKER_HOST', async () => {
    const d = fakeDocker();
    const { svc, seen } = makeService(d.client);
    await svc.onModuleInit();
    expect(seen[0]).toEqual({ kind: 'tcp', protocol: 'http', host: 'docker-proxy', port: 2375 });
    expect(svc.isEnabled()).toBe(true);
  });

  it('still uses a mounted socket when DOCKER_HOST is empty (self-host without the proxy)', async () => {
    const d = fakeDocker();
    const { svc, seen } = makeService(d.client, {}, { 'docker.host': '' });
    await svc.onModuleInit();
    expect(seen[0]).toEqual({ kind: 'socket', socketPath: '/var/run/docker.sock' });
  });

  it('retries in the background when the proxy is not up yet, instead of staying disabled', async () => {
    const d = fakeDocker();
    d.client.ping
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const { svc } = makeService(d.client);
    await svc.onModuleInit();
    expect(svc.isEnabled()).toBe(false);
    for (let i = 0; i < 20 && !svc.isEnabled(); i++) await flush();
    expect(svc.isEnabled()).toBe(true);
    expect(d.client.ping).toHaveBeenCalledTimes(3);
  });

  it('reads only a 404 as a missing container; a proxy refusal is "unknown"', async () => {
    const d = fakeDocker();
    const { svc } = makeService(d.client);
    await svc.onModuleInit();
    d.container('gone').inspect.mockRejectedValueOnce(httpError(404, 'no such container'));
    d.container('denied').inspect.mockRejectedValueOnce(httpError(403, 'Request forbidden by administrative rules'));
    expect(await svc.getContainerStatus('gone')).toBe('not_found');
    expect(await svc.getContainerStatus('denied')).toBe('unknown');
  });

  it('never marks a dedicated database FAILED because the proxy refused to inspect it', async () => {
    const d = fakeDocker();
    d.container('bf-pg-a').inspect.mockRejectedValue(httpError(403));
    d.container('bf-pg-b').inspect.mockRejectedValue(httpError(404));
    const projectInfrastructure = {
      findMany: jest.fn(async () => [
        { id: 'a', pgContainerName: 'bf-pg-a' },
        { id: 'b', pgContainerName: 'bf-pg-b' },
      ]),
      update: jest.fn(async () => ({})),
    };
    const { svc } = makeService(d.client, { projectInfrastructure });
    await svc.onModuleInit();
    expect(projectInfrastructure.update).toHaveBeenCalledTimes(1);
    expect(projectInfrastructure.update).toHaveBeenCalledWith({ where: { id: 'b' }, data: { status: 'FAILED' } });
  });

  it('restarts an exited dedicated container at boot (containers/{id}/start)', async () => {
    const d = fakeDocker();
    d.container('bf-pg-x').inspect.mockResolvedValue({ State: { Status: 'exited' } });
    const projectInfrastructure = {
      findMany: jest.fn(async () => [{ id: 'x', pgContainerName: 'bf-pg-x' }]),
      update: jest.fn(async () => ({})),
    };
    const { svc } = makeService(d.client, { projectInfrastructure });
    await svc.onModuleInit();
    expect(d.container('bf-pg-x').start).toHaveBeenCalled();
    expect(projectInfrastructure.update).not.toHaveBeenCalled();
  });

  it('provisions a dedicated Postgres with volumes + containers calls only, on the configured network', async () => {
    const d = fakeDocker();
    const { svc } = makeService(d.client);
    await svc.onModuleInit();
    const out = await svc.provisionPostgres({ projectId: 'p1', projectSlug: 'demo', memoryMb: 256, cpuMillis: 500 });
    expect(d.client.createVolume).toHaveBeenCalledWith(expect.objectContaining({ Name: 'bf-pg-demo-data' }));
    const opts = d.client.createContainer.mock.calls[0][0];
    expect(opts).toMatchObject({ name: 'bf-pg-demo', Image: 'pg-image' });
    expect(opts.HostConfig).toMatchObject({ NetworkMode: 'kolaybase_internal', Binds: ['bf-pg-demo-data:/var/lib/postgresql/data'] });
    // Nothing the proxy should never allow: no privileged mode, no host paths.
    expect(opts.HostConfig.Privileged).toBeUndefined();
    expect(opts.HostConfig.Binds.every((b: string) => !b.startsWith('/'))).toBe(true);
    expect(d.container('bf-pg-demo').start).toHaveBeenCalled();
    expect(out).toMatchObject({ host: 'bf-pg-demo', port: 5432, containerName: 'bf-pg-demo' });
  });

  it('discards a container and its volume (containers stop/delete, volumes delete)', async () => {
    const d = fakeDocker();
    const { svc } = makeService(d.client);
    await svc.onModuleInit();
    await svc.discardPostgresContainer('bf-pg-demo', 'bf-pg-demo-data');
    expect(d.container('bf-pg-demo').stop).toHaveBeenCalled();
    expect(d.container('bf-pg-demo').remove).toHaveBeenCalled();
    expect(d.client.getVolume).toHaveBeenCalledWith('bf-pg-demo-data');
    expect(d.volume.remove).toHaveBeenCalled();
  });
});
