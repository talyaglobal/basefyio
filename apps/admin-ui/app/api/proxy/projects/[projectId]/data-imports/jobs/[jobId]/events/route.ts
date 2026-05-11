/**
 * SSE proxy for the data-import job event stream.
 *
 * Why this dedicated route exists (instead of just falling through the
 * catch-all `[...path]/route.ts`): Next.js' default Response handling buffers
 * a streaming upstream until the body completes, which means EventSource on
 * the browser side sees zero events until the import finishes — the wizard
 * sits at "Starting…" 0% even though the worker is happily updating progress.
 * Forwarding the upstream body raw, with `dynamic = 'force-dynamic'` and
 * disabling Next's static optimization, lets the SSE frames stream through
 * one-at-a-time. Mirrors the existing import-supabase/events route.
 */

import { NextRequest } from 'next/server';

const BACKEND_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; jobId: string }> },
) {
  const { projectId, jobId } = await params;

  // The browser can't set Authorization on an EventSource; the client passes
  // the token as a `?token=…` query param, which our SSE endpoint expects.
  // Fall back to a real Authorization header for non-browser callers.
  const token =
    request.headers.get('Authorization') ||
    request.nextUrl.searchParams.get('token');

  const target = `${BACKEND_URL}/api/projects/${projectId}/data-imports/jobs/${jobId}/events`;

  const upstream = await fetch(target, {
    headers: {
      ...(token
        ? { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` }
        : {}),
      Accept: 'text/event-stream',
    },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response(
      JSON.stringify({ message: 'Failed to connect to data-import job stream' }),
      { status: upstream.status || 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // nginx / Cloudflare default to buffering streamed responses; this
      // header is the standard opt-out.
      'X-Accel-Buffering': 'no',
    },
  });
}
