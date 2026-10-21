import 'reflect-metadata';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import {
  RealtimeDataStreamController,
  parseChannels,
  parsePresence,
} from './realtime-data.controller';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';
import { QueryAccessTokenGuard } from './query-access-token.guard';

/**
 * The stream route's inputs and its guards.
 *
 * The route used to look the key up itself; it now sits behind ApiKeyGuard,
 * the guard that protects rest/v1, so what it accepts and refuses is settled
 * in one place. These tests pin that, and the parsing of the new parameters.
 */
const anon: ApiKeyPayload = { projectId: 'p1', role: 'anon', dbRole: 'anon' };
const user: ApiKeyPayload = { projectId: 'p1', role: 'anon', dbRole: 'authenticated', jwtClaims: { sub: 'user-1' } };

describe('parseChannels', () => {
  it('keeps table, collection and broadcast channels and drops everything else', () => {
    expect(parseChannels('table:orders, collection:posts,broadcast:room-1,user:x,table:bad-name,,broadcast:')).toEqual([
      'table:orders',
      'collection:posts',
      'broadcast:room-1',
    ]);
  });
  it('allows a colon inside a broadcast channel name but not inside an entity name', () => {
    expect(parseChannels('broadcast:room:42')).toEqual(['broadcast:room:42']);
    expect(parseChannels('table:a:b')).toEqual([]);
  });
  it('returns no channels for no input', () => {
    expect(parseChannels(undefined)).toEqual([]);
    expect(parseChannels('')).toEqual([]);
  });
});

describe('parsePresence', () => {
  const channels = ['broadcast:room'];

  it('is absent when no presence key is given', () => {
    expect(parsePresence(undefined, undefined, anon, channels)).toBeUndefined();
    expect(parsePresence('  ', undefined, anon, channels)).toBeUndefined();
  });
  it('uses the given key, with optional metadata', () => {
    expect(parsePresence('alice', '{"color":"red"}', anon, channels)).toEqual({ key: 'alice', meta: { color: 'red' } });
    expect(parsePresence('alice', undefined, anon, channels)).toEqual({ key: 'alice', meta: undefined });
  });
  it('"auto" takes the signed-in user\'s id and refuses an anonymous caller', () => {
    expect(parsePresence('auto', undefined, user, channels)).toEqual({ key: 'user-1', meta: undefined });
    expect(() => parsePresence('auto', undefined, anon, channels)).toThrow(BadRequestException);
  });
  it('refuses a key outside the alphabet, or presence without explicit channels', () => {
    expect(() => parsePresence('bad key!', undefined, anon, channels)).toThrow(BadRequestException);
    expect(() => parsePresence('a'.repeat(129), undefined, anon, channels)).toThrow(BadRequestException);
    expect(() => parsePresence('alice', undefined, anon, [])).toThrow(/explicit channels/);
  });
  it('refuses metadata that is not a small JSON object', () => {
    expect(() => parsePresence('alice', '[1,2]', anon, channels)).toThrow(BadRequestException);
    expect(() => parsePresence('alice', 'not json', anon, channels)).toThrow(BadRequestException);
    expect(() => parsePresence('alice', JSON.stringify({ x: 'y'.repeat(1100) }), anon, channels)).toThrow(/1024 bytes/);
  });
});

describe('RealtimeDataStreamController', () => {
  it('puts the stream behind QueryAccessTokenGuard then ApiKeyGuard, in that order', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, RealtimeDataStreamController.prototype.stream);
    expect(guards).toEqual([QueryAccessTokenGuard, ApiKeyGuard]);
  });

  it('puts broadcast behind ApiKeyGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, RealtimeDataStreamController.prototype.broadcast);
    expect(guards).toEqual([ApiKeyGuard]);
  });

  it('broadcast hands the guard\'s payload, the body and the first forwarded hop to the service', async () => {
    const broadcastService = { broadcastFromClient: jest.fn().mockResolvedValue({ ok: true, eventId: 'e' }) };
    const ctl = new RealtimeDataStreamController({} as any, broadcastService as any);
    const req: any = { apiKeyPayload: anon, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, ip: '10.0.0.1' };
    const body = { channel: 'room', event: 'ping', payload: 1 };
    await expect(ctl.broadcast(body, req)).resolves.toEqual({ ok: true, eventId: 'e' });
    expect(broadcastService.broadcastFromClient).toHaveBeenCalledWith(anon, body, '203.0.113.9');
  });

  it('broadcast without a guard payload is refused', async () => {
    const ctl = new RealtimeDataStreamController({} as any, { broadcastFromClient: jest.fn() } as any);
    await expect(ctl.broadcast({}, { headers: {} } as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('stream subscribes with the role and claims the guard resolved, and the presence it parsed', async () => {
    const realtime = { subscribe: jest.fn().mockReturnValue('sub-1'), heartbeat: jest.fn(), unsubscribe: jest.fn() };
    const ctl = new RealtimeDataStreamController(realtime as any, {} as any);
    const req: any = { apiKeyPayload: user, headers: {}, on: jest.fn() };
    const res: any = { setHeader: jest.fn(), flushHeaders: jest.fn(), end: jest.fn() };
    jest.useFakeTimers();
    await ctl.stream('table:orders,broadcast:room', 'auto', '{"a":1}', req, res);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(realtime.subscribe).toHaveBeenCalledWith('p1', ['table:orders', 'broadcast:room'], res, {
      role: 'authenticated',
      jwtClaims: { sub: 'user-1' },
      presenceKey: 'user-1',
      presenceMeta: { a: 1 },
    });
    const close = req.on.mock.calls.find(([evt]: [string]) => evt === 'close')[1];
    close();
    expect(realtime.unsubscribe).toHaveBeenCalledWith('sub-1');
    expect(res.end).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('stream refuses a bad presence request before any header is written', async () => {
    const realtime = { subscribe: jest.fn() };
    const ctl = new RealtimeDataStreamController(realtime as any, {} as any);
    const res: any = { setHeader: jest.fn(), flushHeaders: jest.fn() };
    await expect(ctl.stream(undefined, 'alice', undefined, { apiKeyPayload: anon, headers: {} } as any, res)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(res.setHeader).not.toHaveBeenCalled();
    expect(realtime.subscribe).not.toHaveBeenCalled();
  });
});
