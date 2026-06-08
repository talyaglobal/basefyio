import { cookies } from "next/headers";
import Link from "next/link";

const AUTH_MARKER_KEY = "bf_logged_in";

export async function AuthNav({ appUrl }: { appUrl: string }) {
  const cookieStore = await cookies();
  const loggedIn = cookieStore.get(AUTH_MARKER_KEY)?.value === "1";

  if (loggedIn) {
    return (
      <Link
        href={`${appUrl}/dashboard`}
        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
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
