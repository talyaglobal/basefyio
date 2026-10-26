import { RealtimeStreamService } from './realtime-stream.service';

/**
 * When the process drains, every dashboard stream is told to reconnect and
 * ended, so the browser comes back to a replica that is staying.
 */
describe('RealtimeStreamService.closeAllForDrain', () => {
  it('sends a reconnect frame, ends every stream, and forgets them', () => {
    const svc = new RealtimeStreamService();
    const streams = [0, 1].map(() => {
      const writes: string[] = [];
      const res = { write: (s: string) => void writes.push(s), end: jest.fn() } as any;
      return { res, writes };
    });
    for (const s of streams) svc.subscribe('u1', ['team:t1'], s.res);
    expect(RealtimeStreamService.localConnectionCount()).toBe(2);

    const n = RealtimeStreamService.closeAllForDrain();

    expect(n).toBe(2);
    for (const s of streams) {
      expect(s.writes.join('')).toContain('event: reconnect');
      expect(s.res.end).toHaveBeenCalledTimes(1);
    }
    expect(RealtimeStreamService.localConnectionCount()).toBe(0);
  });

  it('keeps going when one socket is already gone', () => {
    const svc = new RealtimeStreamService();
    // Alive at subscription time, gone by the time the drain writes to it.
    let gone = false;
    const dead = {
      write: () => {
        if (gone) throw new Error('EPIPE');
      },
      end: jest.fn(),
    } as any;
    const live = { write: jest.fn(), end: jest.fn() } as any;
    svc.subscribe('u1', [], dead);
    svc.subscribe('u2', [], live);
    gone = true;

    expect(RealtimeStreamService.closeAllForDrain()).toBe(2);
    expect(live.end).toHaveBeenCalledTimes(1);
    expect(RealtimeStreamService.localConnectionCount()).toBe(0);
  });
});
