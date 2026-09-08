import { NextRequest, NextResponse } from 'next/server';
import { runSeoAudit } from '@/lib/seo-audit';

const BACKEND_URL = process.env.API_INTERNAL_URL || 'http://localhost:4000';
const SITE_URL = process.env.SEO_AUDIT_SITE_URL || 'https://basefyio.com';

export const dynamic = 'force-dynamic';
// The audit fetches the sitemap plus a sample of pages, so it needs longer than
// the default budget.
export const maxDuration = 60;

/**
 * Fails closed: without a valid ROOT token this returns 401/403 and never runs
 * the audit. The audit makes outbound requests, so it must not be open.
 */
async function requireRoot(request: NextRequest): Promise<NextResponse | null> {
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/profile`, {
      headers: { authorization: auth },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }
    const profile = (await res.json()) as { role?: string };
    if (profile.role !== 'ROOT') {
      return NextResponse.json({ message: 'Forbidden' }, { status: 403 });
    }
    return null;
  } catch {
    return NextResponse.json({ message: 'Could not verify session' }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  const denied = await requireRoot(request);
  if (denied) return denied;

  try {
    const result = await runSeoAudit(SITE_URL);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { message: err instanceof Error ? err.message : 'Audit failed' },
      { status: 500 },
    );
  }
}
