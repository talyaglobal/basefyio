import {
  describeDockerConnection,
  dockerConnectionFromConfig,
  dockerConnectionFromEnv,
  dockerHttpTarget,
  dockerodeOptions,
  resolveDockerConnection,
} from './docker-connection';

describe('resolveDockerConnection', () => {
  it('uses the mounted socket when DOCKER_HOST is empty', () => {
    expect(resolveDockerConnection({})).toEqual({ kind: 'socket', socketPath: '/var/run/docker.sock' });
    expect(resolveDockerConnection({ host: '', socketPath: '/run/d.sock' })).toEqual({
      kind: 'socket',
      socketPath: '/run/d.sock',
    });
  });

  it('reads unix:// as a socket path', () => {
    expect(resolveDockerConnection({ host: 'unix:///var/run/docker.sock' })).toEqual({
      kind: 'socket',
      socketPath: '/var/run/docker.sock',
    });
  });

  it('reaches the proxy over tcp (the default deployment)', () => {
    const conn = resolveDockerConnection({ host: 'tcp://docker-proxy:2375', socketPath: '/var/run/docker.sock' });
    expect(conn).toEqual({ kind: 'tcp', protocol: 'http', host: 'docker-proxy', port: 2375 });
    expect(dockerodeOptions(conn)).toEqual({ host: 'docker-proxy', port: 2375, protocol: 'http' });
    expect(dockerHttpTarget(conn)).toEqual({ https: false, options: { host: 'docker-proxy', port: 2375 } });
    expect(describeDockerConnection(conn)).toBe('http://docker-proxy:2375');
  });

  it('accepts a bare host:port and https', () => {
    expect(resolveDockerConnection({ host: 'docker-proxy:2375' })).toMatchObject({ host: 'docker-proxy', port: 2375 });
    expect(resolveDockerConnection({ host: 'https://docker.example' })).toEqual({
      kind: 'tcp',
      protocol: 'https',
      host: 'docker.example',
      port: 2376,
    });
  });

  it('fails loudly on an address it cannot use, instead of silently falling back to a socket', () => {
    expect(() => resolveDockerConnection({ host: 'ssh://root@host' })).toThrow(/unsupported scheme/);
    expect(() => resolveDockerConnection({ host: 'tcp://' })).toThrow();
  });

  it('gives socket options for a socket connection', () => {
    const conn = resolveDockerConnection({ socketPath: '/var/run/docker.sock' });
    expect(dockerodeOptions(conn)).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(dockerHttpTarget(conn)).toEqual({ https: false, options: { socketPath: '/var/run/docker.sock' } });
  });

  it('resolves the same way from the environment and from the Nest config', () => {
    const env = { DOCKER_HOST: 'tcp://docker-proxy:2375', DOCKER_SOCKET_PATH: '/x.sock' };
    const config = { get: (k: string) => ({ 'docker.host': env.DOCKER_HOST, 'docker.socketPath': env.DOCKER_SOCKET_PATH } as any)[k] };
    expect(dockerConnectionFromEnv(env as any)).toEqual(dockerConnectionFromConfig(config));
  });
});
