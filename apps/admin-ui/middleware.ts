import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/signup', '/'];
const FORCE_PASSWORD_CHANGE_PATH = '/set-new-password';

const isConsolePath = (pathname: string) => pathname === '/console' || pathname.startsWith('/console/');

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

  // IMPORTANT: do NOT redirect to /login from middleware based on cookies.
  // The source of truth for the session is the access token in localStorage,
  // which middleware (server-side) cannot read. The JWT cookie is also dropped
  // by the browser when the token exceeds the ~4KB cookie limit. Both caused a
  // brand-new tab / fresh navigation to bounce to /login even though the user
  // was still logged in. Auth is enforced client-side in dashboard/layout.tsx
  // (which reads localStorage and persists across tabs/restarts) and by the API
  // (every request needs the bearer token), so the page route itself stays
  // open and the client redirects genuinely logged-out users. This is what
  // makes "never log out unless the user explicitly logs out" hold.
  const forcePasswordChange = request.cookies.get('basefyio_force_password_change')?.value === '1';

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
  matcher: ['/', '/dashboard/:path*', '/console/:path*', '/set-new-password'],
};
