import { RealtimeDataService } from './realtime-data.service';
import type { FanoutMessage } from './realtime-data.types';

/**
 * The service that owns the SSE connections: who gets which frame.
 */
function build() {
  const prisma = {
    realtimeBinding: { findMany: jest.fn().mockResolvedValue([{ kind: 'table', entity: 'orders' }]) },
  } as any;
  let deliverer: ((m: FanoutMessage) => void) | null = null;
  const fanout = {
    setLocalDeliverer: jest.fn((fn) => (deliverer = fn)),
    onLocalSubscriberAdded: jest.fn(),
    onLocalSubscriberRemoved: jest.fn(),
    hasAnySubscribers: jest.fn().mockResolvedValue(false),
    publish: jest.fn(),
    publishLocal: jest.fn(),
    instanceId: 'me',
  } as any;
  const policy = {
    filterByPolicy: jest.fn(async (_p: string, event: any, candidates: any[]) => ({ deliverTo: candidates, event })),
  } as any;
  const presence = {
    join: jest.fn().mockResolvedValue(undefined),
    heartbeat: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
  } as any;
  const svc = new RealtimeDataService(prisma, fanout, policy, presence);
  const res = () => ({ write: jest.fn() }) as any;
  const frames = (r: any) => r.write.mock.calls.map(([s]: [string]) => s);
  const deliver = (m: Omit<FanoutMessage, 'v' | 'origin'>) => deliverer!({ ...m, v: 1, origin: 'other' });
  const flush = () => new Promise((r) => setImmediate(r));
  return { svc, prisma, fanout, policy, presence, res, frames, deliver, flush };
}

const change = (entity = 'orders') => ({
  kind: 'data_change' as const,
  projectId: 'p1',
  channel: `table:${entity}`,
  event: { eventId: 'e1', type: 'INSERT', kind: 'table', entity, new: { id: 1 }, old: null, commitTimestamp: 't' },
});

describe('RealtimeDataService', () => {
  it('registers itself as the fan-out\'s local deliverer', () => {
    const { fanout } = build();
    expect(fanout.setLocalDeliverer).toHaveBeenCalledTimes(1);
  });

  it('writes a ready frame with the subscription id, channels and role, and counts the subscriber', () => {
    const { svc, res, frames, fanout } = build();
    const r = res();
    const id = svc.subscribe('p1', [], r, { role: 'authenticated', jwtClaims: { sub: 'u1' } });
    expect(frames(r)[0]).toBe(`event: ready\ndata: ${JSON.stringify({ subscriptionId: id, channels: ['*'], role: 'authenticated' })}\n\n`);
    expect(fanout.onLocalSubscriberAdded).toHaveBeenCalledWith('p1');
    expect(svc.getSubscriber(id)).toMatchObject({ role: 'authenticated', jwtClaims: { sub: 'u1' } });
    expect(svc.getSubscriber(id)!.policyGroup).toHaveLength(32);
  });

  it('defaults to the anon role', () => {
    const { svc, res } = build();
    const id = svc.subscribe('p1', ['table:orders'], res());
    expect(svc.getSubscriber(id)!.role).toBe('anon');
  });

  it('delivers a data change to wildcard and exact-channel subscribers of the project only', async () => {
    const { svc, res, frames, deliver, flush } = build();
    const all = res();
    const exact = res();
    const otherChannel = res();
    const otherProject = res();
    svc.subscribe('p1', [], all);
    svc.subscribe('p1', ['table:orders'], exact);
    svc.subscribe('p1', ['table:users'], otherChannel);
    svc.subscribe('p2', [], otherProject);
    deliver(change());
    await flush();
    expect(frames(all)).toHaveLength(2);
    expect(frames(all)[1]).toMatch(/^event: data_change\n/);
    expect(frames(exact)).toHaveLength(2);
    expect(frames(otherChannel)).toHaveLength(1);
    expect(frames(otherProject)).toHaveLength(1);
  });

  it('runs every data change through the policy filter and writes what it returns', async () => {
    const { svc, res, frames, deliver, flush, policy } = build();
    const a = res();
    const b = res();
    const idA = svc.subscribe('p1', ['table:orders'], a);
    svc.subscribe('p1', ['table:orders'], b);
    policy.filterByPolicy.mockImplementationOnce(async (_p: string, event: any, c: any[]) => ({
      deliverTo: c.filter((s) => s.id === idA),
      event: { ...event, new: { id: 1, filtered: true } },
    }));
    deliver(change());
    await flush();
    expect(frames(a)).toHaveLength(2);
    expect(frames(a)[1]).toContain('"filtered":true');
    expect(frames(b)).toHaveLength(1);
    expect(policy.filterByPolicy).toHaveBeenCalledWith('p1', expect.objectContaining({ eventId: 'e1' }), expect.any(Array));
  });

  it('keeps data changes in publish order even when an earlier check finishes later', async () => {
    const { svc, res, frames, deliver, flush, policy } = build();
    const r = res();
    svc.subscribe('p1', ['table:orders'], r);
    let releaseFirst!: () => void;
    policy.filterByPolicy
      .mockImplementationOnce((_p: string, event: any, c: any[]) =>
        new Promise((resolve) => (releaseFirst = () => resolve({ deliverTo: c, event }))))
      .mockImplementationOnce(async (_p: string, event: any, c: any[]) => ({ deliverTo: c, event }));
    deliver({ ...change(), event: { ...change().event, eventId: 'first' } });
    deliver({ ...change(), event: { ...change().event, eventId: 'second' } });
    await flush();
    expect(frames(r)).toHaveLength(1);
    releaseFirst();
    await flush();
    expect(frames(r).slice(1).map((f: string) => JSON.parse(f.split('data: ')[1]).eventId)).toEqual(['first', 'second']);
  });

  it('delivers broadcast and presence frames at once, honouring exclude and only, and never to the wildcard', () => {
    const { svc, res, frames, deliver } = build();
    const sender = res();
    const other = res();
    const wildcard = res();
    const senderId = svc.subscribe('p1', ['broadcast:room'], sender);
    const otherId = svc.subscribe('p1', ['broadcast:room'], other);
    svc.subscribe('p1', [], wildcard);
    deliver({ kind: 'broadcast', projectId: 'p1', channel: 'broadcast:room', event: { x: 1 }, exclude: senderId });
    expect(frames(sender)).toHaveLength(1);
    expect(frames(other)).toHaveLength(2);
    expect(frames(other)[1]).toBe('event: broadcast\ndata: {"x":1}\n\n');
    expect(frames(wildcard)).toHaveLength(1);
    deliver({ kind: 'presence', projectId: 'p1', channel: 'broadcast:room', event: { type: 'sync' }, only: otherId });
    expect(frames(sender)).toHaveLength(1);
    expect(frames(other)).toHaveLength(3);
  });

  it('drops a subscriber whose connection cannot be written, and tells the fan-out', async () => {
    const { svc, res, frames, deliver, flush, fanout } = build();
    const broken = res();
    const fine = res();
    svc.subscribe('p1', ['table:orders'], broken);
    svc.subscribe('p1', ['table:orders'], fine);
    broken.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    deliver(change());
    await flush();
    expect(fanout.onLocalSubscriberRemoved).toHaveBeenCalledWith('p1');
    expect(svc.hasSubscribers('p1')).toBe(true);
    expect(frames(fine)).toHaveLength(2);
    deliver(change());
    await flush();
    expect(broken.write).toHaveBeenCalledTimes(2); // ready + the failed write, nothing after
  });

  it('a heartbeat pings, and drops a dead connection', () => {
    const { svc, res, frames, fanout } = build();
    const r = res();
    const id = svc.subscribe('p1', [], r);
    svc.heartbeat(id);
    expect(frames(r)[1]).toMatch(/^event: ping\n/);
    r.write.mockImplementation(() => {
      throw new Error('closed');
    });
    svc.heartbeat(id);
    expect(svc.getSubscriber(id)).toBeUndefined();
    expect(fanout.onLocalSubscriberRemoved).toHaveBeenCalledTimes(1);
  });

  it('publishChange does nothing when no instance has a subscriber', async () => {
    const { svc, prisma, fanout } = build();
    svc.publishChange('p1', { type: 'INSERT', kind: 'table', entity: 'orders', new: { id: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(prisma.realtimeBinding.findMany).not.toHaveBeenCalled();
    expect(fanout.publish).not.toHaveBeenCalled();
  });

  it('publishChange skips an entity that is not bound, and fans a bound one out', async () => {
    const { svc, res, fanout } = build();
    svc.subscribe('p1', [], res());
    svc.publishChange('p1', { type: 'INSERT', kind: 'table', entity: 'users', new: { id: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(fanout.publish).not.toHaveBeenCalled();
    svc.publishChange('p1', { type: 'UPDATE', kind: 'table', entity: 'orders', new: { id: 1 }, old: { id: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(fanout.publish).toHaveBeenCalledTimes(1);
    expect(fanout.publish.mock.calls[0][0]).toMatchObject({
      kind: 'data_change',
      projectId: 'p1',
      channel: 'table:orders',
      event: expect.objectContaining({ type: 'UPDATE', entity: 'orders', new: { id: 1 }, old: { id: 1 } }),
    });
  });

  it('publishChange asks the fan-out about other instances when nobody is local', async () => {
    const { svc, fanout } = build();
    fanout.hasAnySubscribers.mockResolvedValueOnce(true);
    svc.publishChange('p1', { type: 'DELETE', kind: 'table', entity: 'orders', old: { id: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(fanout.hasAnySubscribers).toHaveBeenCalledWith('p1');
    expect(fanout.publish).toHaveBeenCalledTimes(1);
  });

  it('joins, heartbeats and leaves presence for a subscriber with a presence key', async () => {
    const { svc, res, presence } = build();
    const id = svc.subscribe('p1', ['broadcast:room'], res(), { presenceKey: 'alice', presenceMeta: { a: 1 } });
    expect(presence.join).toHaveBeenCalledWith({
      id,
      projectId: 'p1',
      channels: ['broadcast:room'],
      presenceKey: 'alice',
      presenceMeta: { a: 1 },
    });
    svc.heartbeat(id);
    expect(presence.heartbeat).toHaveBeenCalledWith(id);
    svc.unsubscribe(id);
    expect(presence.leave).toHaveBeenCalledWith(id);
  });

  it('a subscriber without a presence key never touches presence', () => {
    const { svc, res, presence } = build();
    const id = svc.subscribe('p1', ['broadcast:room'], res());
    svc.heartbeat(id);
    svc.unsubscribe(id);
    expect(presence.join).not.toHaveBeenCalled();
    expect(presence.heartbeat).not.toHaveBeenCalled();
    expect(presence.leave).not.toHaveBeenCalled();
  });
});
