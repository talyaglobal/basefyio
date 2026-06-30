/**
 * Dedicated multipart proxy for the data-import inspect endpoint.
 *
 * The generic `[...path]/route.ts` proxy buffers the entire request body via
 * `await request.arrayBuffer()` before forwarding it upstream. For large CSV /
 * XLSX uploads (50 k+ rows, easily 20–100 MB) that:
 *   (a) doubles memory pressure on the admin-ui Node process, and
 *   (b) trips reverse-proxy / platform request-size limits that don't expect
 *       a fully buffered binary payload.
 *
 * Here we stream `request.body` straight to the backend. Node's `fetch`
 * requires `duplex: 'half'` whenever the body is a `ReadableStream`, so we
 * pass it explicitly. The upstream NestJS controller (Multer with
 * memory-storage on `FileInterceptor`) consumes the stream natively.
 *
 * This route also forwards `?firstRowIsHeader=…` and the `Authorization`
 * header without modification.
 */

import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Upload can take a while for 50 MB+ files on slow uplinks. The default
 * `maxDuration` (10 s on some hosts) would 504 mid-upload. 5 minutes is
 * generous; the backend has its own /inspect-time guard.
 */
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const search = request.nextUrl.search;
  const target = `${BACKEND_URL}/api/projects/${projectId}/data-imports/inspect${search}`;

  const headers = new Headers(request.headers);
  // Hop-by-hop and host-specific headers must not be forwarded.
  headers.delete('host');
  headers.delete('connection');
  headers.delete('content-length');
  headers.delete('transfer-encoding');

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: request.body,
      // Required by Node's undici when the body is a stream — otherwise the
      // request fails with "RequestInit: duplex option is required when
      // sending a body".
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const upstreamCt = upstream.headers.get('content-type') || '';
    if (!upstream.ok) {
      // Surface the upstream error verbatim so the wizard's toast shows the
      // real reason ("File too large", "Unsupported file type", etc.).
      const text = await upstream.text();
      return new NextResponse(text || `Upstream ${upstream.status}`, {
        status: upstream.status,
        headers: { 'content-type': upstreamCt || 'application/json' },
      });
    }

    const json = await upstream.text();
    return new NextResponse(json, {
      status: 200,
      headers: { 'content-type': upstreamCt || 'application/json' },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        message: `Proxy failure forwarding to platform-api: ${
          err?.message || 'unknown error'
        }`,
      },
      { status: 502 },
    );
  }
}
