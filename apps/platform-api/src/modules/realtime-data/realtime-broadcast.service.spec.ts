import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { RealtimeBroadcastService } from './realtime-broadcast.service';
import type { ApiKeyPayload } from '../../common/guards/api-key.guard';

/**
 * Client-to-client messages, bounded.
 *
 * A broadcast is validated, size-capped and rate-limited, then handed to the
 * fan-out; no database is involved. The public anon key may send one, so the
 * limits are what stands between a leaked key and a flood.
 */
function build(env: Record<string, string> = {}, redisReady = true) {
  const counters = new Map<string, number>();
  const client = {
    incr: jest.fn(async (k: string) => {
      const n = (counters.get(k) ?? 0) + 1;
      counters.set(k, n);
      return n;
    }),
    expire: jest.fn().mockResolvedValue(1),
  };
  const redis = { isReady: () => redisReady, getClient: () => client } as any;
  const fanout = { publish: jest.fn() } as any;
  const config = { get: (k: string) => env[k] } as any;
  const svc = new RealtimeBroadcastService(redis, fanout, config);
  return { svc, fanout, client };
}

const anon = (claims?: Record<string, unknown>): ApiKeyPayload => ({
  projectId: 'p1',
  role: 'anon',
  dbRole: claims ? 'authenticated' : 'anon',
  jwtClaims: claims,
});
const service: ApiKeyPayload = { projectId: 'p1', role: 'service', dbRole: 'service_role' };

const body = { channel: 'room-1', event: 'cursor', payload: { x: 1 }, from: 'sub-1' };

describe('RealtimeBroadcastService', () => {
  it('fans a valid message out on broadcast:<channel>, excluding the sender\'s own subscription', async () => {
    const { svc, fanout } = build();
    const res = await svc.broadcastFromClient(anon({ sub: 'u1' }), body, '1.2.3.4');
    expect(res.ok).toBe(true);
    expect(fanout.publish).toHaveBeenCalledTimes(1);
    const msg = fanout.publish.mock.calls[0][0];
    expect(msg).toMatchObject({ kind: 'broadcast', projectId: 'p1', channel: 'broadcast:room-1', exclude: 'sub-1' });
    expect(msg.event).toMatchObject({
      eventId: res.eventId,
      channel: 'room-1',
      event: 'cursor',
      payload: { x: 1 },
      sender: { role: 'authenticated', sub: 'u1' },
    });
  });

  it('refuses a channel or event name outside the allowed alphabet', async () => {
    const { svc } = build();
    await expect(svc.broadcastFromClient(anon(), { ...body, channel: 'bad channel' }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.broadcastFromClient(anon(), { ...body, channel: '' }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.broadcastFromClient(anon(), { ...body, event: 'a'.repeat(65) }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.broadcastFromClient(anon(), { ...body, from: 'x'.repeat(65) }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.broadcastFromClient(anon(), { ...body, from: 42 }, 'ip')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a payload above REALTIME_BROADCAST_MAX_BYTES', async () => {
    const { svc } = build({ REALTIME_BROADCAST_MAX_BYTES: '16' });
    await expect(
      svc.broadcastFromClient(anon(), { ...body, payload: { text: 'x'.repeat(100) } }, 'ip'),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('limits each sender per minute and answers 429 beyond the limit', async () => {
    const { svc } = build({ REALTIME_BROADCAST_RATE_PER_MIN: '2' });
    await svc.broadcastFromClient(anon(), body, '9.9.9.9');
    await svc.broadcastFromClient(anon(), body, '9.9.9.9');
    const err = await svc.broadcastFromClient(anon(), body, '9.9.9.9').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    // another sender is not affected
    await expect(svc.broadcastFromClient(anon(), body, '8.8.8.8')).resolves.toMatchObject({ ok: true });
  });

  it('keys the sender bucket by the signed-in user, not the address, when a token is present', async () => {
    const { svc, client } = build();
    await svc.broadcastFromClient(anon({ sub: 'u1' }), body, '1.1.1.1');
    expect(client.incr).toHaveBeenCalledWith('rt:bc:p1:u1');
    await svc.broadcastFromClient(anon(), body, '1.1.1.1');
    expect(client.incr).toHaveBeenCalledWith('rt:bc:p1:ip:1.1.1.1');
  });

  it('limits the whole project regardless of sender; 0 switches broadcast off', async () => {
    const { svc } = build({ REALTIME_BROADCAST_PROJECT_RATE_PER_MIN: '1' });
    await svc.broadcastFromClient(anon(), body, '1.1.1.1');
    const err = await svc.broadcastFromClient(anon(), body, '2.2.2.2').catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(429);

    const off = build({ REALTIME_BROADCAST_PROJECT_RATE_PER_MIN: '0' });
    const err2 = await off.svc.broadcastFromClient(service, body, 'ip').catch((e) => e);
    expect((err2 as HttpException).getStatus()).toBe(429);
  });

  it('the service key skips the per-sender bucket but still counts against the project', async () => {
    const { svc, client } = build({ REALTIME_BROADCAST_RATE_PER_MIN: '1' });
    await svc.broadcastFromClient(service, body, 'ip');
    await expect(svc.broadcastFromClient(service, body, 'ip')).resolves.toMatchObject({ ok: true });
    const keys = client.incr.mock.calls.map((c) => c[0]);
    expect(keys.every((k) => k === 'rt:bc:p1')).toBe(true);
  });

  it('with REALTIME_BROADCAST_REQUIRE_JWT=1 a bare anon key is refused and a signed-in user accepted', async () => {
    const { svc } = build({ REALTIME_BROADCAST_REQUIRE_JWT: '1' });
    await expect(svc.broadcastFromClient(anon(), body, 'ip')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.broadcastFromClient(anon({ sub: 'u1' }), body, 'ip')).resolves.toMatchObject({ ok: true });
    await expect(svc.broadcastFromClient(service, body, 'ip')).resolves.toMatchObject({ ok: true });
  });

  it('falls back to in-memory counters while Redis is unavailable', async () => {
    const { svc, client } = build({ REALTIME_BROADCAST_RATE_PER_MIN: '1' }, false);
    await svc.broadcastFromClient(anon(), body, '5.5.5.5');
    const err = await svc.broadcastFromClient(anon(), body, '5.5.5.5').catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(client.incr).not.toHaveBeenCalled();
  });

  it('accepts a missing payload as null and never stores anything', async () => {
    const { svc, fanout } = build();
    await svc.broadcastFromClient(anon(), { channel: 'c', event: 'e' }, 'ip');
    expect(fanout.publish.mock.calls[0][0].event.payload).toBeNull();
    expect(fanout.publish.mock.calls[0][0].exclude).toBeUndefined();
  });
});
