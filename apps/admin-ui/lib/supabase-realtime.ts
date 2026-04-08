import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import type { RealtimeEventEnvelope } from './realtime-types';

let client: ReturnType<typeof createClient> | null = null;

function getRealtimeClient() {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  client = createClient(url, anon, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}

export function isRealtimePhase1Enabled() {
  return process.env.NEXT_PUBLIC_KB_REALTIME_PHASE1 === '1';
}

export function subscribeKbRealtime(
  channelName: string,
  onEvent: (event: RealtimeEventEnvelope) => void,
): (() => void) | null {
  if (!isRealtimePhase1Enabled()) return null;
  const c = getRealtimeClient();
  if (!c) return null;

  let disposed = false;
  let channel: RealtimeChannel | null = null;
  let retryMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const attach = () => {
    if (disposed) return;
    channel = c.channel(channelName);
    channel.on('broadcast', { event: 'kb_event' }, ({ payload }) => {
      onEvent(payload as RealtimeEventEnvelope);
    });
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        retryMs = 1000;
        return;
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (disposed) return;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (channel) c.removeChannel(channel);
          attach();
        }, retryMs);
        retryMs = Math.min(retryMs * 2, 15000);
      }
    });
  };

  attach();

  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (channel) c.removeChannel(channel);
  };
}

