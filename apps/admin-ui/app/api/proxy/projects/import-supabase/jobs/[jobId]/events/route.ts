import { NextRequest } from 'next/server';

const BACKEND_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;

  const token =
    request.headers.get('Authorization') ||
    (request.nextUrl.searchParams.get('ticket') ? null : request.nextUrl.searchParams.get('token'));

  // A single-use stream ticket goes to the API in the URL; it is spent on
  // first use, so a copy in a log is worthless. `token` is the old way, kept
  // for dashboards loaded before tickets existed.
  const ticket = request.nextUrl.searchParams.get('ticket');
  const base = `${BACKEND_URL}/api/projects/import-supabase/jobs/${jobId}/events`;
  const target = ticket ? `${base}?ticket=${encodeURIComponent(ticket)}` : base;

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
      JSON.stringify({ message: 'Failed to connect to import job stream' }),
      { status: upstream.status || 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
