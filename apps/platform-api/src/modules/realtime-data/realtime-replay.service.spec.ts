import { RealtimeReplayService } from './realtime-replay.service';

const svc = () =>
  new RealtimeReplayService({ isReady: () => false } as any, { get: () => undefined } as any);
const msg = (id: string, extra: object = {}) =>
  ({ v: 1, origin: 'me', kind: 'data_change', projectId: 'p1', channel: 'table:orders', event: { eventId: id }, ...extra }) as any;

describe('RealtimeReplayService (no Redis)', () => {
  it('returns what came after the last id the client saw', async () => {
    const s = svc();
    ['a', 'b', 'c'].forEach((id) => s.record(msg(id)));
    const r = await s.since('p1', 'a');
    expect(r.found).toBe(true);
    expect(r.entries.map((e) => e.id)).toEqual(['b', 'c']);
  });
  it('reports a gap when the id is unknown, and never records a frame meant for one subscriber', async () => {
    const s = svc();
    s.record(msg('a'));
    s.record(msg('only-me', { only: 'sub-1' }));
    expect((await s.since('p1', 'zzz')).found).toBe(false);
    expect((await s.since('p1', 'a')).entries).toEqual([]);
  });
  it('keeps at most maxEvents per project', async () => {
    const s = svc();
    for (let i = 0; i < s.maxEvents + 5; i++) s.record(msg(`e${i}`));
    expect((await s.since('p1', 'e0')).found).toBe(false);
  });
  it('records for a project without subscribers only while it is warm', async () => {
    const s = svc();
    expect(await s.isWarm('p1')).toBe(false);
    s.markWarm('p1');
    expect(await s.isWarm('p1')).toBe(true);
  });
});
