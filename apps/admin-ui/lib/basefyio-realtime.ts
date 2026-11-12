import type { RealtimeEventEnvelope } from './realtime-types';
import { getAccessToken } from './auth';
import { api } from './api';
import { ticketedStreamUrl } from './ticketed-event-source';

/**
 * Realtime is on by default. The legacy NEXT_PUBLIC_BASEFYIO_REALTIME_PHASE1 opt-in
 * is still recognised but ignored when the new NEXT_PUBLIC_BASEFYIO_REALTIME_DISABLE
 * kill switch is set. Set NEXT_PUBLIC_BASEFYIO_REALTIME_DISABLE=1 to fall back to
 * the polling notification path without a redeploy.
 */
export function isRealtimePhase1Enabled() {
  if (process.env.NEXT_PUBLIC_BASEFYIO_REALTIME_DISABLE === '1') return false;
  return true;
}

export function subscribebasefyioRealtime(
  channelName: string,
  onEvent: (event: RealtimeEventEnvelope) => void,
): (() => void) | null {
  if (!isRealtimePhase1Enabled()) return null;
  if (!getAccessToken()) return null;

  let disposed = false;
  let source: EventSource | null = null;
  let retryMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const seenEventIds = new Set<string>();

  const scheduleRetry = () => {
    if (disposed) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      void attach();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  };

  // Each (re)connect mints a single-use stream ticket; the access token never
  // goes into the URL (see lib/ticketed-event-source.ts).
  const attach = async () => {
    if (disposed) return;
    let url: string;
    try {
      url = await ticketedStreamUrl({
        proxyPath: '/api/proxy/realtime/stream',
        apiPath: '/api/realtime/stream',
        params: { channels: channelName },
        mint: (path) => api.auth.streamTicket(path),
        legacy: { param: 'access_token', token: getAccessToken },
      });
    } catch {
      scheduleRetry();
      return;
    }
    if (disposed) return;
    source = new EventSource(url);

    source.addEventListener('kb_event', (raw) => {
      try {
        const evt = raw as MessageEvent<string>;
        const event = JSON.parse(evt.data) as RealtimeEventEnvelope;
        if (event.eventId && seenEventIds.has(event.eventId)) return;
        if (event.eventId) {
          seenEventIds.add(event.eventId);
          if (seenEventIds.size > 300) {
            const first = seenEventIds.values().next().value;
            if (first) seenEventIds.delete(first);
          }
        }
        onEvent(event);
      } catch {
        // Ignore malformed event payloads.
      }
    });

    source.onopen = () => {
      retryMs = 1000;
    };

    source.onerror = () => {
      if (disposed) return;
      if (source) {
        source.close();
        source = null;
      }
      scheduleRetry();
    };
  };

  void attach();

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (source) source.close();
  };
}
