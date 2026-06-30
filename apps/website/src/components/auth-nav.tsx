import { cookies } from "next/headers";
import Link from "next/link";

// The admin-ui writes the cross-subdomain marker as `basefyio_logged_in` on
// `.basefyio.com`. `bf_logged_in` is kept only as a fallback for any older
// cookie. A mismatch here is why the marketing nav showed "Sign In" while a
// session was active on app.basefyio.com.
const AUTH_MARKER_KEYS = ["basefyio_logged_in", "bf_logged_in"];

export async function AuthNav({ appUrl }: { appUrl: string }) {
  const cookieStore = await cookies();
  const loggedIn = AUTH_MARKER_KEYS.some(
    (key) => cookieStore.get(key)?.value === "1",
  );

  if (loggedIn) {
    // Green pill with white text so it's obvious the visitor is signed in.
    return (
      <Link
        href={`${appUrl}/dashboard`}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
      >
        Dashboard
      </Link>
    );
  }

  return (
    <Link
      href={appUrl}
      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      Sign In
    </Link>
  );
}
