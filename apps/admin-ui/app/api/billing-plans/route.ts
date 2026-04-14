import { NextResponse } from 'next/server';

const BACKEND_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';

// Cache the plans response for 5 minutes at the Next.js edge/server level.
// This avoids the catch-all proxy (which is force-dynamic) for this public endpoint.
export const revalidate = 300;

export async function GET() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/billing/plans`, {
      next: { revalidate: 300 },
    });

    if (!res.ok) {
      return NextResponse.json([], { status: res.status });
    }

    const data = await res.json();

    return NextResponse.json(data, {
      headers: {
        // Allow the browser to cache for 60s as well, revalidate in background
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
      },
    });
  } catch {
    return NextResponse.json([], { status: 502 });
  }
}
