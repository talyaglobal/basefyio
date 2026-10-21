/**
 * Realtime — data change subscriptions, presence and client-to-client
 * broadcast over SSE.
 *
 * Tables/collections broadcast only after being enabled in the dashboard
 * (Settings → Realtime). Changes arrive as `data_change` with
 * { type: INSERT|UPDATE|DELETE, kind, entity, new, old, commitTimestamp }.
 *
 * Transport: with no signed-in user the stream opens with the platform
 * EventSource (browser-native; Node 22+ ships a global EventSource — older
 * Node needs a polyfill assigned to globalThis), the anon key in the URL as it
 * always was. When a user is signed in, the stream is read with `fetch` so the
 * key and the user's access token travel as headers and never in a URL; a
 * table with row-level security then delivers only the rows that user may
 * read. `transport: 'eventsource'` forces the EventSource path (the token is
 * then sent as `?access_token=`), `transport: 'fetch'` forces fetch.
 */

import type { BasefyioError } from '../lib/types.js';

export type RealtimeChangeType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface RealtimeChangePayload<T = Record<string, unknown>> {
  eventId: string;
  type: RealtimeChangeType;
  kind: 'table' | 'collection';
  entity: string;
  new: T | null;
  old: Partial<T> | null;
  commitTimestamp: string;
}

export interface RealtimeSubscribeOptions {
  /** Relational table to watch. */
  table?: string;
  /** NoSQL collection to watch. */
  collection?: string;
  /** Filter by change type. Default: all. */
  event?: RealtimeChangeType | '*';
}

export interface RealtimeSubscription {
  unsubscribe(): void;
}

export type RealtimeTransport = 'auto' | 'fetch' | 'eventsource';

export interface RealtimeClientOptions {
  /** Returns the signed-in user's access token, or null when nobody is signed in. */
  tokenAccessor?: () => string | null;
  /** How the stream is opened. Default `auto`: EventSource without a token, fetch with one. */
  transport?: RealtimeTransport;
  /** fetch implementation to use instead of the global one. */
  fetch?: typeof globalThis.fetch;
}

/** A message another client sent with `channel.send()`. */
export interface RealtimeBroadcastMessage<P = unknown> {
  eventId: string;
  channel: string;
  event: string;
  payload: P;
  sender: { role: string; sub?: string };
  sentAt: string;
}

export interface RealtimePresenceMember {
  key: string;
  meta?: Record<string, unknown>;
  lastSeen: number;
}

export interface RealtimePresenceEvent {
  type: 'sync' | 'join' | 'leave';
  channel: string;
  key?: string;
  meta?: Record<string, unknown>;
  members?: RealtimePresenceMember[];
  truncated?: boolean;
  at: string;
}

export interface RealtimeChannelOptions {
  /** Join the channel's presence under this key; `'auto'` uses the signed-in user's id. */
  presenceKey?: string | 'auto';
  /** Small JSON object shown to the other members (at most 1 KB). */
  presenceMeta?: Record<string, unknown>;
}

/** The first frame of a stream. */
export interface RealtimeReady {
  subscriptionId: string;
  channels: string[];
  role?: string;
  presence?: string;
}

export interface RealtimeStreamParams {
  channels: string[];
  presence?: string;
  presenceMeta?: Record<string, unknown>;
}

export interface RealtimeStreamHandle {
  close(): void;
}

type FrameHandler = (event: string, data: string) => void;

type EventSourceLike = {
  addEventListener(type: string, cb: (e: { data: string }) => void): void;
  close(): void;
  onerror: ((e: unknown) => void) | null;
};

/** SSE frames the server emits; the EventSource path listens to each by name. */
const FRAME_EVENTS = ['ready', 'data_change', 'broadcast', 'presence', 'ping'];

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15_000;

/**
 * Incremental parser for a `text/event-stream` body: feed it text as it
 * arrives, get back the complete frames it contains.
 */
export class SseParser {
  private buffer = '';
  private event = 'message';
  private data: string[] = [];

  feed(chunk: string): Array<{ event: string; data: string }> {
    this.buffer += chunk;
    const out: Array<{ event: string; data: string }> = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') });
        this.event = 'message';
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
      // `id` and `retry` carry nothing this client needs.
    }
    return out;
  }
}

export class RealtimeClient {
  private readonly tokenAccessor: () => string | null;
  private readonly transport: RealtimeTransport;
  private readonly fetchImpl: typeof globalThis.fetch | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    options: RealtimeClientOptions = {},
  ) {
    this.tokenAccessor = options.tokenAccessor ?? (() => null);
    this.transport = options.transport ?? 'auto';
    this.fetchImpl = options.fetch;
  }

  /**
   * Subscribe to data changes. Reconnects automatically with backoff.
   *
   * @example
   * const sub = bf.realtime.subscribe(
   *   { table: 'orders', event: 'INSERT' },
   *   (change) => console.log('new order', change.new),
   * );
   * // later: sub.unsubscribe()
   */
  subscribe<T = Record<string, unknown>>(
    options: RealtimeSubscribeOptions,
    callback: (change: RealtimeChangePayload<T>) => void,
  ): RealtimeSubscription {
    const channels: string[] = [];
    if (options.table) channels.push(`table:${options.table}`);
    if (options.collection) channels.push(`collection:${options.collection}`);
    const wantedEvent = options.event ?? '*';

    const handle = this.openStream({ channels }, (event, data) => {
      if (event !== 'data_change') return;
      try {
        const change = JSON.parse(data) as RealtimeChangePayload<T>;
        if (wantedEvent !== '*' && change.type !== wantedEvent) return;
        callback(change);
      } catch {
        // Malformed frame — skip.
      }
    });

    return { unsubscribe: () => handle.close() };
  }

  /**
   * A named channel for presence and client-to-client messages (it can carry
   * data-change subscriptions too, so one connection serves a screen).
   *
   * @example
   * const room = bf.realtime.channel('room-1', { presenceKey: 'auto' })
   *   .on('presence', { event: 'sync' }, () => render(room.presenceState()))
   *   .on('broadcast', { event: 'cursor' }, (msg) => draw(msg.payload));
   * await room.subscribe();
   * await room.send({ event: 'cursor', payload: { x: 1, y: 2 } });
   */
  channel(name: string, options: RealtimeChannelOptions = {}): RealtimeChannel {
    return new RealtimeChannel(this, name, options);
  }

  /**
   * Send a broadcast without a channel object. `from` is the subscription id
   * that must not receive its own message.
   */
  async broadcast(
    channel: string,
    event: string,
    payload: unknown,
    from?: string,
  ): Promise<{ eventId: string }> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) throw new Error('fetch is not available in this environment');
    const headers: Record<string, string> = { apikey: this.apiKey, 'Content-Type': 'application/json' };
    const token = this.tokenAccessor();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetchImpl(`${this.apiUrl}/api/realtime/v1/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel, event, payload, from }),
    });
    if (!res.ok) {
      let message = `Broadcast failed with status ${res.status}`;
      try {
        const body = await res.json();
        message = body.message || message;
      } catch {}
      const err: BasefyioError = { message, status: res.status };
      throw err;
    }
    return (await res.json()) as { eventId: string };
  }

  /** The stream URL for the given parameters. */
  buildStreamUrl(params: RealtimeStreamParams, opts: { keyInUrl: boolean; token: string | null }): string {
    const q = new URLSearchParams();
    if (opts.keyInUrl) q.set('apikey', this.apiKey);
    if (params.channels.length) q.set('channels', params.channels.join(','));
    if (params.presence) q.set('presence', params.presence);
    if (params.presenceMeta) q.set('presence_meta', JSON.stringify(params.presenceMeta));
    if (opts.token) q.set('access_token', opts.token);
    return `${this.apiUrl}/api/realtime/v1/stream?${q.toString()}`;
  }

  /**
   * Open a stream and hand every frame to `onFrame`. Reconnects with backoff
   * until closed. Used by `subscribe()` and by channels.
   */
  openStream(params: RealtimeStreamParams, onFrame: FrameHandler): RealtimeStreamHandle {
    const token = this.tokenAccessor();
    const useFetch =
      this.transport === 'fetch' || (this.transport === 'auto' && !!token && this.canStreamWithFetch());
    return useFetch ? this.openFetchStream(params, onFrame) : this.openEventSourceStream(params, onFrame);
  }

  private canStreamWithFetch(): boolean {
    return (
      typeof (this.fetchImpl ?? globalThis.fetch) === 'function' &&
      typeof ReadableStream !== 'undefined' &&
      typeof TextDecoder !== 'undefined'
    );
  }

  private openEventSourceStream(params: RealtimeStreamParams, onFrame: FrameHandler): RealtimeStreamHandle {
    const EventSourceCtor = (globalThis as { EventSource?: new (url: string) => EventSourceLike }).EventSource;
    if (!EventSourceCtor) {
      throw new Error(
        'EventSource is not available. In Node < 22 assign a polyfill to globalThis.EventSource.',
      );
    }

    let disposed = false;
    let source: EventSourceLike | null = null;
    let retryMs = RETRY_MIN_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attach = () => {
      if (disposed) return;
      const url = this.buildStreamUrl(params, { keyInUrl: true, token: this.tokenAccessor() });
      source = new EventSourceCtor(url);
      for (const name of FRAME_EVENTS) {
        source.addEventListener(name, (raw) => {
          retryMs = RETRY_MIN_MS;
          onFrame(name, raw.data);
        });
      }
      source.onerror = () => {
        if (disposed) return;
        source?.close();
        source = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(attach, retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      };
    };

    attach();

    return {
      close: () => {
        disposed = true;
        if (retryTimer) clearTimeout(retryTimer);
        source?.close();
      },
    };
  }

  private openFetchStream(params: RealtimeStreamParams, onFrame: FrameHandler): RealtimeStreamHandle {
    const fetchImpl = (this.fetchImpl ?? globalThis.fetch) as typeof globalThis.fetch;
    const url = this.buildStreamUrl(params, { keyInUrl: false, token: null });
    let disposed = false;
    let controller: AbortController | null = null;
    let retryMs = RETRY_MIN_MS;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;

    const run = async () => {
      while (!disposed) {
        controller = new AbortController();
        try {
          const headers: Record<string, string> = { apikey: this.apiKey, Accept: 'text/event-stream' };
          const token = this.tokenAccessor();
          if (token) headers['Authorization'] = `Bearer ${token}`;
          const res = await fetchImpl(url, { headers, signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`stream failed with status ${res.status}`);
          retryMs = RETRY_MIN_MS;
          await this.readSse(res.body, onFrame);
        } catch {
          // Connection lost or refused — fall through to the retry wait.
        }
        if (disposed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
          retryTimer = setTimeout(resolve, retryMs);
        });
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    };
    void run();

    return {
      close: () => {
        disposed = true;
        if (retryTimer) clearTimeout(retryTimer);
        controller?.abort();
        wake?.();
      },
    };
  }

  private async readSse(body: ReadableStream<Uint8Array>, onFrame: FrameHandler): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parser.feed(decoder.decode(value, { stream: true }))) {
          onFrame(frame.event, frame.data);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
  }
}

interface BroadcastListener {
  event?: string;
  cb: (msg: RealtimeBroadcastMessage) => void;
}
interface PresenceListener {
  event: RealtimePresenceEvent['type'];
  cb: (ev: RealtimePresenceEvent) => void;
}
interface ChangeListener {
  channel: string;
  event: RealtimeChangeType | '*';
  cb: (change: RealtimeChangePayload) => void;
}

/**
 * One named channel: presence, broadcast and optional data-change
 * subscriptions over a single connection.
 */
export class RealtimeChannel {
  private handle: RealtimeStreamHandle | null = null;
  private subscriptionId: string | null = null;
  private subscribed = false;
  private presenceKey: string | undefined;
  private presenceMeta: Record<string, unknown> | undefined;
  private readonly members = new Map<string, RealtimePresenceMember>();
  private readyWaiters: Array<{ resolve: (v: { subscriptionId: string }) => void; reject: (e: Error) => void }> = [];
  private readonly broadcastListeners: BroadcastListener[] = [];
  private readonly presenceListeners: PresenceListener[] = [];
  private readonly changeListeners: ChangeListener[] = [];

  constructor(
    private readonly client: RealtimeClient,
    readonly name: string,
    options: RealtimeChannelOptions = {},
  ) {
    this.presenceKey = options.presenceKey;
    this.presenceMeta = options.presenceMeta;
  }

  on(type: 'broadcast', filter: { event?: string }, cb: (msg: RealtimeBroadcastMessage) => void): this;
  on(
    type: 'presence',
    filter: { event: RealtimePresenceEvent['type'] },
    cb: (ev: RealtimePresenceEvent) => void,
  ): this;
  on(
    type: 'data_change',
    filter: { table?: string; collection?: string; event?: RealtimeChangeType | '*' },
    cb: (change: RealtimeChangePayload) => void,
  ): this;
  on(type: 'broadcast' | 'presence' | 'data_change', filter: any, cb: any): this {
    if (type === 'broadcast') {
      this.broadcastListeners.push({ event: filter?.event, cb });
    } else if (type === 'presence') {
      this.presenceListeners.push({ event: filter.event, cb });
    } else {
      const channel = filter.table ? `table:${filter.table}` : filter.collection ? `collection:${filter.collection}` : null;
      if (!channel) throw new Error('data_change needs a table or a collection');
      const known = this.changeListeners.some((l) => l.channel === channel);
      this.changeListeners.push({ channel, event: filter.event ?? '*', cb });
      // A new entity has to be part of the subscription on the wire.
      if (this.subscribed && !known) this.reopen();
    }
    return this;
  }

  /** Open the connection; resolves with the server's subscription id. */
  subscribe(): Promise<{ subscriptionId: string }> {
    this.subscribed = true;
    this.open();
    if (this.subscriptionId) return Promise.resolve({ subscriptionId: this.subscriptionId });
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  unsubscribe(): void {
    this.subscribed = false;
    this.handle?.close();
    this.handle = null;
    this.subscriptionId = null;
    this.members.clear();
    const waiters = this.readyWaiters.splice(0);
    for (const w of waiters) w.reject(new Error('unsubscribed'));
  }

  /**
   * Join the channel's presence (reconnecting if already subscribed). Uses the
   * presence key given at creation, or `'auto'` — the signed-in user's id.
   */
  async track(meta?: Record<string, unknown>): Promise<void> {
    this.presenceKey = this.presenceKey ?? 'auto';
    if (meta !== undefined) this.presenceMeta = meta;
    if (this.subscribed) {
      this.reopen();
      await this.subscribe();
    }
  }

  /** Leave presence while staying subscribed to the channel. */
  async untrack(): Promise<void> {
    this.presenceKey = undefined;
    this.presenceMeta = undefined;
    this.members.clear();
    if (this.subscribed) {
      this.reopen();
      await this.subscribe();
    }
  }

  /** Members currently on the channel, kept up to date from presence frames. */
  presenceState(): RealtimePresenceMember[] {
    return [...this.members.values()];
  }

  /**
   * Send a message to the other subscribers of this channel. The sender's own
   * connection does not receive it unless `echo` is set.
   */
  send(message: { event: string; payload?: unknown }, opts: { echo?: boolean } = {}): Promise<{ eventId: string }> {
    const from = opts.echo ? undefined : this.subscriptionId ?? undefined;
    return this.client.broadcast(this.name, message.event, message.payload ?? null, from);
  }

  /** Channels this object listens to on the wire. */
  channels(): string[] {
    const set = new Set<string>([`broadcast:${this.name}`]);
    for (const l of this.changeListeners) set.add(l.channel);
    return [...set];
  }

  private open(): void {
    if (this.handle) return;
    this.handle = this.client.openStream(
      { channels: this.channels(), presence: this.presenceKey, presenceMeta: this.presenceMeta },
      (event, data) => this.onFrame(event, data),
    );
  }

  private reopen(): void {
    this.handle?.close();
    this.handle = null;
    this.subscriptionId = null;
    this.open();
  }

  private onFrame(event: string, data: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    switch (event) {
      case 'ready': {
        this.subscriptionId = typeof parsed?.subscriptionId === 'string' ? parsed.subscriptionId : null;
        if (this.subscriptionId) {
          const waiters = this.readyWaiters.splice(0);
          for (const w of waiters) w.resolve({ subscriptionId: this.subscriptionId });
        }
        return;
      }
      case 'broadcast': {
        const msg = parsed as RealtimeBroadcastMessage;
        if (msg.channel !== this.name) return;
        for (const l of this.broadcastListeners) if (!l.event || l.event === msg.event) l.cb(msg);
        return;
      }
      case 'presence': {
        const ev = parsed as RealtimePresenceEvent;
        // Presence is kept per wire channel; this object's room is its broadcast channel.
        if (ev.channel !== `broadcast:${this.name}`) return;
        this.reducePresence(ev);
        for (const l of this.presenceListeners) if (l.event === ev.type) l.cb(ev);
        return;
      }
      case 'data_change': {
        const change = parsed as RealtimeChangePayload;
        const channel = `${change.kind}:${change.entity}`;
        for (const l of this.changeListeners) {
          if (l.channel === channel && (l.event === '*' || l.event === change.type)) l.cb(change);
        }
        return;
      }
      default:
        return;
    }
  }

  private reducePresence(ev: RealtimePresenceEvent): void {
    if (ev.type === 'sync') {
      this.members.clear();
      for (const m of ev.members ?? []) this.members.set(m.key, m);
    } else if (ev.type === 'join' && ev.key) {
      this.members.set(ev.key, { key: ev.key, meta: ev.meta, lastSeen: Date.parse(ev.at) || Date.now() });
    } else if (ev.type === 'leave' && ev.key) {
      this.members.delete(ev.key);
    }
  }
}
