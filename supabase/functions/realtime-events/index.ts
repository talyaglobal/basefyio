import { createClient } from 'npm:@supabase/supabase-js@2';
import type { RealtimeEventEnvelope } from '../_shared/realtime-types.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-kb-edge-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const sharedSecret = Deno.env.get('KB_REALTIME_EDGE_SECRET') || '';
  const incomingSecret = req.headers.get('x-kb-edge-secret') || '';
  if (sharedSecret && incomingSecret !== sharedSecret) {
    return new Response(JSON.stringify({ message: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const payload = (await req.json()) as RealtimeEventEnvelope;
  if (!payload?.eventId || !payload?.entityType || !payload?.entityId) {
    return new Response(JSON.stringify({ message: 'Invalid payload' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const channels = new Set<string>();
  if (payload.teamId) channels.add(`team:${payload.teamId}`);
  if (payload.projectId) channels.add(`project:${payload.projectId}`);
  for (const uid of payload.userIds || []) channels.add(`user:${uid}`);

  await Promise.all(
    Array.from(channels).map((channelName) =>
      supabase.channel(channelName).send({
        type: 'broadcast',
        event: 'kb_event',
        payload,
      }),
    ),
  );

  return new Response(JSON.stringify({ ok: true, channels: Array.from(channels) }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

