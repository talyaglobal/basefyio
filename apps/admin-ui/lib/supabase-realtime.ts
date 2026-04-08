import type { RealtimeEventEnvelope } from './realtime-types';
import { getAccessToken } from './auth';

export function isRealtimePhase1Enabled() {
  return process.env.NEXT_PUBLIC_KB_REALTIME_PHASE1 === '1';
}

export function subscribeKbRealtime(
  channelName: string,
  onEvent: (event: RealtimeEventEnvelope) => void,
): (() => void) | null {
  if (!isRealtimePhase1Enabled()) return null;
  const token = getAccessToken();
  if (!token) return null;

  let disposed = false;
  let source: EventSource | null = null;
  let retryMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const seenEventIds = new Set<string>();

  const attach = () => {
    if (disposed) return;
    const params = new URLSearchParams({
      channels: channelName,
      access_token: token,
    });
    source = new EventSource(`/api/proxy/realtime/stream?${params.toString()}`);

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
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        attach();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
  };

  attach();

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (source) source.close();
  };
}

