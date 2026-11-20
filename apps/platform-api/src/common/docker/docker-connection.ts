/**
 * Where the platform reaches the Docker Engine API.
 *
 * The default deployment no longer mounts the Docker socket into the API: a
 * least-privilege proxy (`docker-proxy`, tecnativa/docker-socket-proxy) sits on
 * an internal-only network and forwards only the API sections the platform
 * uses. The API reaches it through `DOCKER_HOST=tcp://docker-proxy:2375`.
 * Installs that still mount the socket set `DOCKER_HOST=unix:///var/run/docker.sock`
 * (or leave `DOCKER_HOST` empty and set `DOCKER_SOCKET_PATH`).
 *
 * Every Docker client in the API is built from this one resolver, so the
 * choice is made in exactly one place.
 */

export type DockerConnection =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; protocol: 'http' | 'https'; host: string; port: number };

export interface DockerConnectionSource {
  /** DOCKER_HOST: tcp://host:port, http(s)://host:port or unix:///path. */
  host?: string | null;
  /** DOCKER_SOCKET_PATH, used when DOCKER_HOST is empty. */
  socketPath?: string | null;
}

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

export function resolveDockerConnection(src: DockerConnectionSource = {}): DockerConnection {
  const raw = (src.host ?? '').trim();
  const fallbackSocket = (src.socketPath ?? '').trim() || DEFAULT_DOCKER_SOCKET;
  if (!raw) return { kind: 'socket', socketPath: fallbackSocket };

  if (raw.startsWith('unix://')) {
    return { kind: 'socket', socketPath: raw.slice('unix://'.length) || fallbackSocket };
  }

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `tcp://${raw}`);
  } catch {
    throw new Error(`DOCKER_HOST "${raw}" is not a valid address (expected tcp://host:port or unix:///path)`);
  }
  if (!['tcp:', 'http:', 'https:'].includes(url.protocol)) {
    throw new Error(`DOCKER_HOST "${raw}" uses an unsupported scheme ${url.protocol} (tcp, http, https or unix)`);
  }
  if (!url.hostname) {
    throw new Error(`DOCKER_HOST "${raw}" names no host`);
  }
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  const port = url.port ? Number.parseInt(url.port, 10) : protocol === 'https' ? 2376 : 2375;
  return { kind: 'tcp', protocol, host: url.hostname, port };
}

/** The same resolution, from the process environment (for services without ConfigService). */
export function dockerConnectionFromEnv(env: NodeJS.ProcessEnv = process.env): DockerConnection {
  return resolveDockerConnection({ host: env.DOCKER_HOST, socketPath: env.DOCKER_SOCKET_PATH });
}

/** Constructor options for dockerode. */
export function dockerodeOptions(conn: DockerConnection): {
  socketPath?: string;
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
} {
  return conn.kind === 'socket'
    ? { socketPath: conn.socketPath }
    : { host: conn.host, port: conn.port, protocol: conn.protocol };
}

/** Request options for a raw node:http(s) call against the Engine API. */
export function dockerHttpTarget(conn: DockerConnection): {
  https: boolean;
  options: { socketPath?: string; host?: string; port?: number };
} {
  return conn.kind === 'socket'
    ? { https: false, options: { socketPath: conn.socketPath } }
    : { https: conn.protocol === 'https', options: { host: conn.host, port: conn.port } };
}

/** For logs: where the client points, never anything secret (there is nothing secret here). */
export function describeDockerConnection(conn: DockerConnection): string {
  return conn.kind === 'socket' ? `unix://${conn.socketPath}` : `${conn.protocol}://${conn.host}:${conn.port}`;
}

/** The resolution from the Nest config (`docker.host`, `docker.socketPath`). */
export function dockerConnectionFromConfig(config: { get<T = any>(key: string): T | undefined }): DockerConnection {
  return resolveDockerConnection({
    host: config.get<string>('docker.host'),
    socketPath: config.get<string>('docker.socketPath'),
  });
}
