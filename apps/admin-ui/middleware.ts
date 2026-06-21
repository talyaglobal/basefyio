import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/'];
const FORCE_PASSWORD_CHANGE_PATH = '/set-new-password';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p)) {
    return NextResponse.next();
  }

  // Treat the session as present if EITHER the access-token cookie OR the
  // lightweight `basefyio_logged_in` marker is set. The real token lives in
  // localStorage (the SPA reads/refreshes it client-side); the JWT cookie can
  // be dropped by the browser when the token exceeds the ~4KB cookie limit,
  // which previously redirected a brand-new tab to /login even though the user
  // was still logged in. The marker is tiny, set on the root domain, and only
  // cleared on explicit logout — so this never drops a live session, and a
  // genuinely logged-out user (no cookies at all) still goes to /login.
  const token = request.cookies.get('basefyio_access_token')?.value;
  const loggedInMarker = request.cookies.get('basefyio_logged_in')?.value === '1';
  const forcePasswordChange = request.cookies.get('basefyio_force_password_change')?.value === '1';

  if (!token && !loggedInMarker) {
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
