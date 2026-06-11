/**
 * Dedicated SSE proxy for the realtime event stream.
 *
 * The catch-all `[...path]/route.ts` has maxDuration=60 and buffers
 * streaming responses in some Next.js runtimes, which breaks long-lived
 * SSE connections (ERR_HTTP2_PROTOCOL_ERROR / 502 after ~60s). This
 * dedicated route streams the upstream body raw without buffering.
 */

import { NextRequest } from 'next/server';

const BACKEND_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const channels = request.nextUrl.searchParams.get('channels') || '';
  const token =
    request.headers.get('Authorization') ||
    request.nextUrl.searchParams.get('access_token');

  const target = new URL(`${BACKEND_URL}/api/realtime/stream`);
  if (channels) target.searchParams.set('channels', channels);

  const upstream = await fetch(target.toString(), {
    headers: {
      ...(token
        ? { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` }
        : {}),
      Accept: 'text/event-stream',
    },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(
      JSON.stringify({ message: 'Failed to connect to realtime stream' }),
      { status: upstream.status || 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
