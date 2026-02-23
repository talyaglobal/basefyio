import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL =
  process.env.API_INTERNAL_URL || 'http://localhost:4000';

async function proxy(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const url = new URL(request.url);
  const query = url.search;
  const target = `${BACKEND_URL}/api/${params.path.join('/')}${query}`;

  const headers = new Headers(request.headers);
  headers.delete('host');

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

    if (upstreamCt.includes('application/octet-stream') || upstreamCt.includes('image/')) {
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

    const responseBody = await upstream.text();

    return new NextResponse(responseBody, {
      status: upstream.status,
      headers: {
        'content-type': upstreamCt || 'application/json',
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { message: `Backend unreachable: ${err.message}` },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
