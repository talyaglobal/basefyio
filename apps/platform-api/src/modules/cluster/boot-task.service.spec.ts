import { BootTaskService } from './boot-task.service';

/**
 * A boot task runs on the first process to claim it and nowhere else for a
 * while; with Redis away it runs everywhere, as it did before.
 */
function build(opts: { down?: boolean } = {}) {
  const store = new Map<string, string>();
  const client = {
    set: jest.fn(async (key: string, value: string, _px: string, _ttl: number, nx?: string) => {
      if (opts.down) throw new Error('ECONNREFUSED');
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
  };
  return { svc: new BootTaskService({ getDurableClient: () => client } as any), client, store };
}

describe('BootTaskService', () => {
  it('lets the first process claim a task and refuses the second', async () => {
    const { svc, client } = build();
    await expect(svc.claim('infra-reconcile')).resolves.toBe(true);
    await expect(svc.claim('infra-reconcile')).resolves.toBe(false);
    expect(client.set).toHaveBeenCalledWith('basefyio:boot:infra-reconcile', expect.any(String), 'PX', 600_000, 'NX');
  });

  it('keeps tasks apart', async () => {
    const { svc } = build();
    await svc.claim('a');
    await expect(svc.claim('b')).resolves.toBe(true);
  });

  it('runs everywhere when Redis is unreachable', async () => {
    const { svc } = build({ down: true });
    await expect(svc.claim('infra-reconcile')).resolves.toBe(true);
  });
});
