import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, SseParser } from './realtime';

/**
 * How the client opens the stream, and what it does with the frames.
 *
 * Without a signed-in user the URL is the one it always was — the anon key in
 * the query, native EventSource. With a token the key and the token travel as
 * headers over fetch, so neither reaches a URL.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, Array<(e: { data: string }) => void>>();
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: { data: string }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
  }
}

/** A fetch that answers with an open SSE body we can push frames into. */
function fakeFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let push: ((text: string) => void) | null = null;
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ ok: true, eventId: 'ev-1' }), { status: 202 });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        push = (text) => controller.enqueue(enc.encode(text));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const frame = (event: string, data: unknown) => push?.(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { fetchImpl, calls, frame, settle };
}

const API = 'https://api.example.com';

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as any).EventSource = FakeEventSource;
});
afterEach(() => {
  delete (globalThis as any).EventSource;
});

describe('SseParser', () => {
  it('assembles frames across chunk boundaries and joins multi-line data', () => {
    const p = new SseParser();
    expect(p.feed('event: data_ch')).toEqual([]);
    expect(p.feed('ange\ndata: {"a":\ndata: 1}\n')).toEqual([]);
    expect(p.feed('\n')).toEqual([{ event: 'data_change', data: '{"a":\n1}' }]);
  });
  it('ignores comments, ids and retry hints, defaults the event name and strips CR', () => {
    const p = new SseParser();
    expect(p.feed(': keep-alive\r\nid: 7\r\nretry: 3000\r\ndata: x\r\n\r\n')).toEqual([{ event: 'message', data: 'x' }]);
  });
  it('a blank line with no data is not a frame', () => {
    expect(new SseParser().feed('\n\nevent: ping\n\n')).toEqual([]);
  });
});

describe('RealtimeClient.subscribe', () => {
  it('without a token opens EventSource with the anon key in the query, exactly as before', () => {
    const client = new RealtimeClient(API, 'anon-key');
    const cb = vi.fn();
    const sub = client.subscribe({ table: 'orders', event: 'INSERT' }, cb);
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe(`${API}/api/realtime/v1/stream?apikey=anon-key&channels=table%3Aorders`);
    es.emit('data_change', { type: 'UPDATE', entity: 'orders' });
    es.emit('data_change', { type: 'INSERT', entity: 'orders', new: { id: 1 } });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ type: 'INSERT', new: { id: 1 } });
    sub.unsubscribe();
    expect(es.closed).toBe(true);
  });

  it('with a token reads the stream over fetch, sending key and token as headers and nothing in the URL', async () => {
    const f = fakeFetch();
    const client = new RealtimeClient(API, 'anon-key', { tokenAccessor: () => 'jwt-1', fetch: f.fetchImpl });
    const cb = vi.fn();
    const sub = client.subscribe({ table: 'orders' }, cb);
    await f.settle();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(`${API}/api/realtime/v1/stream?channels=table%3Aorders`);
    expect(f.calls[0].init.headers).toMatchObject({ apikey: 'anon-key', Authorization: 'Bearer jwt-1' });
    f.frame('ready', { subscriptionId: 's1' });
    f.frame('data_change', { type: 'DELETE', entity: 'orders', old: { id: 3 } });
    await f.settle();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ type: 'DELETE', old: { id: 3 } });
    sub.unsubscribe();
  });

  it('transport "eventsource" with a token puts the token in the query instead', () => {
    const client = new RealtimeClient(API, 'anon-key', { tokenAccessor: () => 'jwt-1', transport: 'eventsource' });
    client.subscribe({ collection: 'posts' }, () => undefined);
    expect(FakeEventSource.instances[0].url).toBe(
      `${API}/api/realtime/v1/stream?apikey=anon-key&channels=collection%3Aposts&access_token=jwt-1`,
    );
  });

  it('reconnects with backoff after an error', () => {
    vi.useFakeTimers();
    const client = new RealtimeClient(API, 'anon-key');
    client.subscribe({ table: 'orders' }, () => undefined);
    FakeEventSource.instances[0].onerror?.(new Error('lost'));
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.useRealTimers();
  });
});

describe('RealtimeChannel', () => {
  it('subscribes to its broadcast channel and resolves once the server says ready', async () => {
    const client = new RealtimeClient(API, 'anon-key');
    const room = client.channel('room-1');
    const ready = room.subscribe();
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe(`${API}/api/realtime/v1/stream?apikey=anon-key&channels=broadcast%3Aroom-1`);
    es.emit('ready', { subscriptionId: 'sub-9', channels: ['broadcast:room-1'] });
    await expect(ready).resolves.toEqual({ subscriptionId: 'sub-9' });
  });

  it('dispatches broadcasts by event name and ignores other rooms', async () => {
    const client = new RealtimeClient(API, 'anon-key');
    const room = client.channel('room-1');
    const cursor = vi.fn();
    const any = vi.fn();
    room.on('broadcast', { event: 'cursor' }, cursor).on('broadcast', {}, any);
    void room.subscribe();
    const es = FakeEventSource.instances[0];
    es.emit('broadcast', { channel: 'room-1', event: 'cursor', payload: { x: 1 } });
    es.emit('broadcast', { channel: 'room-1', event: 'chat', payload: 'hi' });
    es.emit('broadcast', { channel: 'room-2', event: 'cursor', payload: { x: 2 } });
    expect(cursor).toHaveBeenCalledTimes(1);
    expect(cursor.mock.calls[0][0].payload).toEqual({ x: 1 });
    expect(any).toHaveBeenCalledTimes(2);
  });

  it('keeps presence state from sync, join and leave, for its own channel only', () => {
    const client = new RealtimeClient(API, 'anon-key');
    const room = client.channel('room-1', { presenceKey: 'alice', presenceMeta: { color: 'red' } });
    const joins = vi.fn();
    room.on('presence', { event: 'join' }, joins);
    void room.subscribe();
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain('presence=alice');
    expect(es.url).toContain(`presence_meta=${encodeURIComponent('{"color":"red"}')}`);
    es.emit('presence', { type: 'sync', channel: 'broadcast:room-1', members: [{ key: 'alice', lastSeen: 1 }], at: 't' });
    es.emit('presence', { type: 'join', channel: 'broadcast:room-1', key: 'bob', meta: { a: 1 }, at: '2026-10-20T00:00:00Z' });
    es.emit('presence', { type: 'join', channel: 'broadcast:other', key: 'carol', at: 't' });
    expect(room.presenceState().map((m) => m.key).sort()).toEqual(['alice', 'bob']);
    expect(joins).toHaveBeenCalledTimes(1);
    es.emit('presence', { type: 'leave', channel: 'broadcast:room-1', key: 'alice', at: 't' });
    expect(room.presenceState().map((m) => m.key)).toEqual(['bob']);
  });

  it('send() posts to the broadcast route with the headers and excludes its own subscription unless echo is asked', async () => {
    const f = fakeFetch();
    const client = new RealtimeClient(API, 'anon-key', { tokenAccessor: () => 'jwt-1', fetch: f.fetchImpl });
    const room = client.channel('room-1');
    const ready = room.subscribe();
    await f.settle();
    f.frame('ready', { subscriptionId: 'sub-1' });
    await ready;

    await expect(room.send({ event: 'cursor', payload: { x: 1 } })).resolves.toEqual({ ok: true, eventId: 'ev-1' });
    const post = f.calls.find((c) => c.init.method === 'POST')!;
    expect(post.url).toBe(`${API}/api/realtime/v1/broadcast`);
    expect(post.init.headers).toMatchObject({
      apikey: 'anon-key',
      Authorization: 'Bearer jwt-1',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(post.init.body as string)).toEqual({ channel: 'room-1', event: 'cursor', payload: { x: 1 }, from: 'sub-1' });

    await room.send({ event: 'ping' }, { echo: true });
    const second = f.calls.filter((c) => c.init.method === 'POST')[1];
    expect(JSON.parse(second.init.body as string)).toEqual({ channel: 'room-1', event: 'ping', payload: null });
    room.unsubscribe();
  });

  it('surfaces a refused broadcast as an error with its status', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Too many broadcasts' }), { status: 429 }));
    const client = new RealtimeClient(API, 'anon-key', { fetch: fetchImpl as unknown as typeof fetch });
    await expect(client.broadcast('room', 'x', {})).rejects.toEqual({ message: 'Too many broadcasts', status: 429 });
  });

  it('track() reopens the stream with presence, untrack() without', async () => {
    const client = new RealtimeClient(API, 'anon-key');
    const room = client.channel('room-1');
    void room.subscribe();
    FakeEventSource.instances[0].emit('ready', { subscriptionId: 's1' });
    const tracking = room.track({ status: 'typing' });
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(FakeEventSource.instances[1].url).toContain('presence=auto');
    expect(FakeEventSource.instances[1].url).toContain('presence_meta=');
    FakeEventSource.instances[1].emit('ready', { subscriptionId: 's2' });
    await tracking;
    const untracking = room.untrack();
    expect(FakeEventSource.instances[2].url).not.toContain('presence');
    FakeEventSource.instances[2].emit('ready', { subscriptionId: 's3' });
    await untracking;
  });

  it('carries data-change subscriptions on the same connection', () => {
    const client = new RealtimeClient(API, 'anon-key');
    const room = client.channel('room-1');
    const inserts = vi.fn();
    room.on('data_change', { table: 'orders', event: 'INSERT' }, inserts);
    void room.subscribe();
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain(`channels=${encodeURIComponent('broadcast:room-1,table:orders')}`);
    es.emit('data_change', { kind: 'table', entity: 'orders', type: 'INSERT', new: { id: 1 } });
    es.emit('data_change', { kind: 'table', entity: 'orders', type: 'UPDATE', new: { id: 1 } });
    es.emit('data_change', { kind: 'table', entity: 'users', type: 'INSERT', new: { id: 1 } });
    expect(inserts).toHaveBeenCalledTimes(1);
    // adding an entity after subscribing reopens so the wire knows about it
    room.on('data_change', { collection: 'posts' }, () => undefined);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].url).toContain(encodeURIComponent('collection:posts'));
  });

  it('unsubscribe closes the connection and rejects a pending ready', async () => {
    const client = new RealtimeClient(API, 'anon-key');
    const room = client.channel('room-1');
    const ready = room.subscribe();
    room.unsubscribe();
    expect(FakeEventSource.instances[0].closed).toBe(true);
    await expect(ready).rejects.toThrow('unsubscribed');
  });
});
