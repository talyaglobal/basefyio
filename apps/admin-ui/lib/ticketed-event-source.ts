/**
 * EventSource for the dashboard's server-sent event streams, authenticated
 * with a single-use stream ticket instead of the access token.
 *
 * The browser's EventSource cannot send an Authorization header, so the
 * access token used to travel in the stream URL — and from there into proxy
 * and server logs. Now each connection first mints a ticket (a normal
 * authenticated POST, so an expired access token is refreshed silently on the
 * way) and puts only that in the URL. The API accepts a ticket once, for one
 * stream, within a minute.
 *
 * Because a ticket is single-use, the browser's own reconnect (which repeats
 * the same URL) cannot work; this wrapper reconnects with a fresh ticket
 * instead, with backoff, until close() is called.
 */

export interface StreamTicketSource {
  /** Same-origin URL of the dashboard's stream proxy, e.g. `/api/proxy/realtime/stream`. */
  proxyPath: string;
  /** The API route the ticket is for, e.g. `/api/realtime/stream`. */
  apiPath: string;
  /** Extra query parameters for the stream (never credentials). */
  params?: Record<string, string>;
  /** Mint a ticket for `apiPath`. */
  mint: (apiPath: string) => Promise<{ ticket: string }>;
  /**
   * The access token and the query name the stream proxy accepted it under,
   * used only when the API is older than stream tickets (it answers 404).
   */
  legacy?: { param: string; token: () => string | undefined };
}

/** The stream URL with a fresh ticket in it. */
export async function ticketedStreamUrl(src: StreamTicketSource): Promise<string> {
  const q = new URLSearchParams(src.params ?? {});
  try {
    const { ticket } = await src.mint(src.apiPath);
    q.set('ticket', ticket);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    const token = src.legacy?.token();
    // An API deployed before stream tickets: keep the stream working the old way.
    if ((status === 404 || status === 405) && src.legacy && token) q.set(src.legacy.param, token);
    else throw err;
  }
  const qs = q.toString();
  return qs ? `${src.proxyPath}?${qs}` : src.proxyPath;
}

type Handler<E extends Event> = ((this: EventSource, ev: E) => unknown) | null;

class TicketedEventSource extends EventTarget {
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;
  readonly withCredentials = false;
  url = '';
  onopen: Handler<Event> = null;
  onmessage: Handler<MessageEvent> = null;
  onerror: Handler<Event> = null;

  private es: EventSource | null = null;
  private closed = false;
  private readonly types = new Set<string>();
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly src: StreamTicketSource) {
    super();
    void this.connect();
  }

  get readyState(): number {
    if (this.closed) return this.CLOSED;
    return this.es ? this.es.readyState : this.CONNECTING;
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
    if (!this.types.has(type)) {
      this.types.add(type);
      if (this.es) this.forward(this.es, type);
    }
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.es?.close();
    this.es = null;
  }

  /** Re-dispatch a named server event from the live connection. */
  private forward(es: EventSource, type: string) {
    if (type === 'open' || type === 'error') return; // handled in connect()
    es.addEventListener(type, (e) => {
      const m = e as MessageEvent;
      this.dispatchEvent(new MessageEvent(type, { data: m.data, lastEventId: m.lastEventId }));
    });
  }

  private scheduleReconnect() {
    if (this.closed || this.retryTimer) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 15000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
  }

  private async connect() {
    if (this.closed) return;
    let url: string;
    try {
      url = await ticketedStreamUrl(this.src);
    } catch {
      const ev = new Event('error');
      this.dispatchEvent(ev);
      this.onerror?.call(this as unknown as EventSource, ev);
      this.scheduleReconnect();
      return;
    }
    if (this.closed) return;

    const es = new EventSource(url);
    this.es = es;
    this.url = url;
    for (const t of this.types) this.forward(es, t);

    es.onmessage = (e) => this.onmessage?.call(this as unknown as EventSource, e);
    es.onopen = () => {
      this.retryMs = 1000;
      const ev = new Event('open');
      this.dispatchEvent(ev);
      this.onopen?.call(this as unknown as EventSource, ev);
    };
    es.addEventListener('error', (e) => {
      // A server-sent `event: error` carries data; a dropped connection does not.
      const fromServer = e instanceof MessageEvent && typeof e.data === 'string';
      const ev = fromServer
        ? new MessageEvent('error', { data: (e as MessageEvent).data })
        : new Event('error');
      this.dispatchEvent(ev);
      this.onerror?.call(this as unknown as EventSource, ev);
      if (fromServer || this.closed || this.es !== es) return;
      // The browser would retry with the same, already spent ticket.
      es.close();
      this.es = null;
      this.scheduleReconnect();
    });
  }
}

/**
 * An EventSource-compatible stream that authenticates with stream tickets.
 * Callers use it exactly like an EventSource (listeners, onerror, close()).
 */
export function openTicketedEventSource(src: StreamTicketSource): EventSource {
  return new TicketedEventSource(src) as unknown as EventSource;
}
