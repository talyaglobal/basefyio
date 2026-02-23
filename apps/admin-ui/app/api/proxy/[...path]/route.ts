import { NextRequest, NextResponse } from 'next/server';

const BACKEND_URL =
  process.env.API_INTERNAL_URL || 'http://localhost:4000';

async function proxy(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const target = `${BACKEND_URL}/api/${params.path.join('/')}`;

  const headers = new Headers(request.headers);
  headers.delete('host');

  const hasBody = !['GET', 'HEAD'].includes(request.method);

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : null,
    });

    const body = await upstream.text();

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'content-type':
          upstream.headers.get('content-type') || 'application/json',
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
