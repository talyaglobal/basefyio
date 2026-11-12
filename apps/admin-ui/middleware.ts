import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/'];
const FORCE_PASSWORD_CHANGE_PATH = '/set-new-password';

const isConsolePath = (pathname: string) => pathname === '/console' || pathname.startsWith('/console/');
const isDashboardPath = (pathname: string) => pathname === '/dashboard' || pathname.startsWith('/dashboard/');

/**
 * Whether this browser shows any sign of a session. The `basefyio_logged_in`
 * marker is written with every login and token refresh (and re-written by the
 * login page when it finds a stored session), and it is small enough never to
 * be dropped like the old JWT cookies, which are accepted too while they last.
 * The tokens themselves live in localStorage, out of the server's sight.
 */
function hasSessionSignal(request: NextRequest): boolean {
  return (
    request.cookies.get('basefyio_logged_in')?.value === '1' ||
    !!request.cookies.get('basefyio_access_token')?.value ||
    !!request.cookies.get('basefyio_refresh_token')?.value
  );
}

/**
 * Signed-in pages are per user: never stored by a CDN or a shared proxy (Next
 * marks prerendered pages `s-maxage=31536000` otherwise), and never indexed.
 */
function privatePage(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate');
  res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return res;
}

/** The old in-app admin routes, mapped onto their place in the root console. */
function legacyAdminToConsole(pathname: string): string | null {
  if (pathname === '/dashboard/admin') return '/console/manage';
  if (pathname.startsWith('/dashboard/admin/')) return `/console/${pathname.slice('/dashboard/admin/'.length)}`;
  return null;
}

/**
 * The root console lives on its own host. `admin.<domain>` serves /console
 * and sends everything in /dashboard to `app.<domain>`; `app.<domain>` hands
 * console and old admin routes over to `admin.<domain>`. Sessions are per
 * origin; the console borrows the app's through /auth/handoff. Other hosts
 * (localhost, previews) are left alone.
 */
function splitConsoleHost(request: NextRequest): NextResponse | null {
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const { pathname, search } = request.nextUrl;
  const legacy = legacyAdminToConsole(pathname);

  if (host.startsWith('admin.')) {
    if (pathname === '/') return NextResponse.redirect(new URL('/console', `https://${host}`));
    if (legacy) return NextResponse.redirect(new URL(legacy + search, `https://${host}`));
    // Includes bare /dashboard, so a non-root bounced off a console page lands
    // on the app instead of looping back into the console.
    if (pathname.startsWith('/dashboard')) {
      return NextResponse.redirect(new URL(pathname + search, `https://app.${host.slice('admin.'.length)}`));
    }
  } else if (host.startsWith('app.') && (legacy || isConsolePath(pathname))) {
    return NextResponse.redirect(new URL((legacy ?? pathname) + search, `https://admin.${host.slice('app.'.length)}`));
  }
  return null;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const consoleRedirect = splitConsoleHost(request);
  if (consoleRedirect) return consoleRedirect;

  if (PUBLIC_PATHS.some((p) => pathname === p)) {
    return NextResponse.next();
  }

  // Server-side gate for signed-in areas, on the session MARKER only.
  //
  // The session itself is the token in localStorage, which the server cannot
  // read, and the old JWT cookie was dropped past ~4KB — redirecting on those
  // bounced signed-in users to /login. The marker has neither problem. A
  // browser with no marker and no legacy cookie has no session to keep, so it
  // goes to /login with `next`; and should a stored session exist after all,
  // the login page forwards straight back (re-writing the marker) instead of
  // showing a form. Expiry is still handled client-side: a 401 refreshes
  // silently, and only a rejected refresh clears the marker and the tokens.
  const signedInArea = isDashboardPath(pathname) || isConsolePath(pathname);
  if (signedInArea && !hasSessionSignal(request)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    loginUrl.searchParams.set('next', pathname + request.nextUrl.search);
    return privatePage(NextResponse.redirect(loginUrl));
  }

  const forcePasswordChange = request.cookies.get('basefyio_force_password_change')?.value === '1';

  // Enforce forced-password-change before any dashboard page.
  // This keeps users out of dashboard routes until they set a new password.
  if (forcePasswordChange && pathname.startsWith('/dashboard')) {
    const setPasswordUrl = new URL(FORCE_PASSWORD_CHANGE_PATH, request.url);
    return privatePage(NextResponse.redirect(setPasswordUrl));
  }

  // If user no longer needs forced change, keep this route inaccessible.
  if (!forcePasswordChange && pathname === FORCE_PASSWORD_CHANGE_PATH) {
    const dashboardUrl = new URL('/dashboard', request.url);
    return NextResponse.redirect(dashboardUrl);
  }

  // Note: FROZEN account restriction is handled in dashboard/layout.tsx (client-side)
  // This provides better UX with real-time subscription data and toast notifications.
  // Frozen accounts are automatically redirected to /dashboard/billing when detected.

  if (signedInArea || pathname === FORCE_PASSWORD_CHANGE_PATH) {
    return privatePage(NextResponse.next());
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/', '/dashboard/:path*', '/console/:path*', '/set-new-password'],
};
