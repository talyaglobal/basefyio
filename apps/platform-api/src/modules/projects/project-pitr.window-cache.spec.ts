import { ProjectPitrService } from './project-pitr.service';

/** #34: the cluster-wide WAL listing is shared and kept for a minute, not re-listed on every page load. */
describe('ProjectPitrService.getRecoveryWindow cluster summary cache', () => {
  function build() {
    const t = (iso: string) => new Date(iso);
    const storage = {
      listPlatformObjects: jest.fn(async (_b: string, prefix: string) => {
        if (prefix.startsWith('p')) return [{ name: 'p1/base/1', lastModified: t('2026-11-20T00:00:00Z') }];
        if (prefix.includes('wal')) {
          return [
            { name: 'w1', lastModified: t('2026-11-23T10:00:00Z') },
            { name: 'w2', lastModified: t('2026-11-23T11:00:00Z') },
          ];
        }
        return [{ name: 'b1', lastModified: t('2026-11-19T00:00:00Z') }];
      }),
    };
    const svc = new ProjectPitrService({} as any, storage as any, {} as any, {} as any, {} as any);
    jest.spyOn(svc as any, 'assertMember').mockResolvedValue(undefined);
    return { svc, storage };
  }

  it('reports the window from the cached summary', async () => {
    const { svc } = build();
    const w = await svc.getRecoveryWindow('p1', 'u1');
    expect(w.walSegmentCount).toBe(2);
    expect(w.latest).toBe('2026-11-23T11:00:00.000Z');
    expect(w.continuousFrom).toBe('2026-11-19T00:00:00.000Z');
  });

  it('lists the cluster once for two quick calls, the project base each time', async () => {
    const { svc, storage } = build();
    await svc.getRecoveryWindow('p1', 'u1');
    await svc.getRecoveryWindow('p1', 'u1');
    const prefixes = storage.listPlatformObjects.mock.calls.map((c) => c[1]);
    expect(prefixes.filter((p) => !p.startsWith('p1/')).length).toBe(2);
    expect(prefixes.filter((p) => p.startsWith('p1/')).length).toBe(2);
  });
});
