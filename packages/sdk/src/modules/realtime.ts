/**
 * Realtime — Supabase-style data change subscriptions over SSE.
 *
 * Tables/collections broadcast only after being enabled in the dashboard
 * (Settings → Realtime). Events arrive as `data_change` with
 * { type: INSERT|UPDATE|DELETE, kind, entity, new, old, commitTimestamp }.
 *
 * Uses the platform EventSource (browser-native; Node 22+ ships a global
 * EventSource — older Node needs a polyfill assigned to globalThis).
 */

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

type EventSourceLike = {
  addEventListener(type: string, cb: (e: { data: string }) => void): void;
  close(): void;
  onerror: ((e: unknown) => void) | null;
};

export class RealtimeClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

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
    const EventSourceCtor = (globalThis as { EventSource?: new (url: string) => EventSourceLike })
      .EventSource;
    if (!EventSourceCtor) {
      throw new Error(
        'EventSource is not available. In Node < 22 assign a polyfill to globalThis.EventSource.',
      );
    }

    const channels: string[] = [];
    if (options.table) channels.push(`table:${options.table}`);
    if (options.collection) channels.push(`collection:${options.collection}`);

    const params = new URLSearchParams({ apikey: this.apiKey });
    if (channels.length) params.set('channels', channels.join(','));
    const url = `${this.apiUrl}/api/realtime/v1/stream?${params.toString()}`;

    let disposed = false;
    let source: EventSourceLike | null = null;
    let retryMs = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const wantedEvent = options.event ?? '*';

    const attach = () => {
      if (disposed) return;
      source = new EventSourceCtor(url);

      source.addEventListener('data_change', (raw) => {
        retryMs = 1000;
        try {
          const change = JSON.parse(raw.data) as RealtimeChangePayload<T>;
          if (wantedEvent !== '*' && change.type !== wantedEvent) return;
          callback(change);
        } catch {
          // Malformed frame — skip.
        }
      });

      source.onerror = () => {
        if (disposed) return;
        source?.close();
        source = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(attach, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      };
    };

    attach();

    return {
      unsubscribe: () => {
        disposed = true;
        if (retryTimer) clearTimeout(retryTimer);
        source?.close();
      },
    };
  }
}
