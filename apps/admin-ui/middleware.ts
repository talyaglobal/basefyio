import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/'];
const FORCE_PASSWORD_CHANGE_PATH = '/set-new-password';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p)) {
    return NextResponse.next();
  }

  // Only accept the actual access token — the kb_logged_in marker is a lightweight
  // hint for the marketing site, not an auth credential.
  const token = request.cookies.get('kb_access_token')?.value;
  const forcePasswordChange = request.cookies.get('kb_force_password_change')?.value === '1';

  if (!token) {
    const loginUrl = new URL('/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Enforce forced-password-change before any dashboard page.
  // This keeps users out of dashboard routes until they set a new password.
  if (forcePasswordChange && pathname.startsWith('/dashboard')) {
    const setPasswordUrl = new URL(FORCE_PASSWORD_CHANGE_PATH, request.url);
    return NextResponse.redirect(setPasswordUrl);
  }

  // If user no longer needs forced change, keep this route inaccessible.
  if (!forcePasswordChange && pathname === FORCE_PASSWORD_CHANGE_PATH) {
    const dashboardUrl = new URL('/dashboard', request.url);
    return NextResponse.redirect(dashboardUrl);
  }

  // Note: FROZEN account restriction is handled in dashboard/layout.tsx (client-side)
  // This provides better UX with real-time subscription data and toast notifications.
  // Frozen accounts are automatically redirected to /dashboard/billing when detected.

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/set-new-password'],
};
