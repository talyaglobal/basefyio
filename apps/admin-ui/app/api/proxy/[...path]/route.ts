import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL =
  process.env.API_INTERNAL_URL || 'http://localhost:4000';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Validate Origin/Referer for state-changing requests to prevent CSRF. */
function validateOrigin(request: NextRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const host = request.headers.get('host');
  if (!host) return false;
  // Accept same-origin requests
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      return originHost === host;
    } catch { return false; }
  }
  if (referer) {
    try {
      const refHost = new URL(referer).host;
      return refHost === host;
    } catch { return false; }
  }
  // No origin or referer — could be server-side fetch, allow cautiously
  return true;
}

async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;

  // Block path traversal attempts
  if (path.some((seg) => seg === '..' || seg === '.' || seg.includes('\0'))) {
    return NextResponse.json({ message: 'Invalid path' }, { status: 400 });
  }

  // CSRF protection: reject cross-origin state-changing requests
  if (!validateOrigin(request)) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const query = url.search;
  const target = `${BACKEND_URL}/api/${path.join('/')}${query}`;

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');
  headers.delete('transfer-encoding');

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const contentType = request.headers.get('content-type') || '';
  const isMultipart = contentType.includes('multipart/form-data');

  try {
    let body: BodyInit | null = null;
    if (hasBody) {
      if (isMultipart) {
        body = await request.arrayBuffer();
      } else {
        body = await request.text();
      }
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
    });

    const upstreamCt = upstream.headers.get('content-type') || '';

    // Pass binary responses through untouched — reading them as text mangles
    // bytes > 127 and corrupts the file (e.g. a PDF then renders as a blank page).
    if (
      upstreamCt.includes('application/octet-stream') ||
      upstreamCt.includes('application/zip') ||
      upstreamCt.includes('application/pdf') ||
      upstreamCt.includes('image/') ||
      upstreamCt.includes('application/vnd.') ||
      upstreamCt.includes('octet')
    ) {
      const blob = await upstream.arrayBuffer();
      return new NextResponse(blob, {
        status: upstream.status,
        headers: {
          'content-type': upstreamCt,
          ...(upstream.headers.get('content-disposition')
            ? { 'content-disposition': upstream.headers.get('content-disposition')! }
            : {}),
        },
      });
    }

    if (upstreamCt.includes('text/event-stream')) {
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        },
      });
    }

    const responseBody = await upstream.text();

    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstreamCt || 'application/json',
      },
    });
  } catch {
    return NextResponse.json(
      { message: 'Backend unreachable' },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
