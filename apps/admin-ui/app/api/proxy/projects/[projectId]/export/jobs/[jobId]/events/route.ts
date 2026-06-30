import { NextRequest } from 'next/server';

const BACKEND_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; jobId: string }> },
) {
  const { projectId, jobId } = await params;

  // EventSource cannot set custom headers in browser, so accept token from query.
  const token =
    request.headers.get('Authorization') ||
    request.nextUrl.searchParams.get('token');

  const target = `${BACKEND_URL}/api/projects/${projectId}/export/jobs/${jobId}/events`;
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
      JSON.stringify({ message: 'Failed to connect to export job stream' }),
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
