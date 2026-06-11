export interface DockerClientInterface {
  runContainer(opts: {
    image: string;
    name: string;
    ports?: { host: number; container: number }[];
    env?: string[];
    labels?: Record<string, string>;
  }): Promise<{ containerId: string }>;

  stopAndRemove(containerId: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

export class DockerCliClient implements DockerClientInterface {
  async runContainer(opts: {
    image: string;
    name: string;
    ports?: { host: number; container: number }[];
    env?: string[];
    labels?: Record<string, string>;
  }): Promise<{ containerId: string }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const args = ['run', '-d', '--name', opts.name];
    for (const p of opts.ports ?? []) args.push('-p', `${p.host}:${p.container}`);
    for (const e of opts.env ?? []) args.push('-e', e);
    for (const [k, v] of Object.entries(opts.labels ?? {})) args.push('--label', `${k}=${v}`);
    args.push(opts.image);

    const { stdout } = await exec('docker', args);
    return { containerId: stdout.trim() };
  }

  async stopAndRemove(containerId: string): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    await exec('docker', ['rm', '-f', containerId]);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('docker', ['info']);
      return true;
    } catch {
      return false;
    }
  }
}
