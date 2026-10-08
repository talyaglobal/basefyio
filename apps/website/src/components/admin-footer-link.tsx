import { cookies } from "next/headers";
import Link from "next/link";

// The admin-ui mirrors ROOT status into this cookie on `.basefyio.com` so the
// marketing site can show the Admin shortcut without reading the session
// itself. It is only a UI hint — /dashboard/admin is gated by the API.
const ROOT_MARKER_KEY = "basefyio_root";

/** The admin console runs on admin.<domain>, next to app.<domain>. */
const toAdminUrl = (appUrl: string) => appUrl.replace("://app.", "://admin.");

export async function AdminFooterLink({
  appUrl,
  className = "text-xs text-muted-foreground transition-colors hover:text-foreground",
}: {
  appUrl: string;
  className?: string;
}) {
  const cookieStore = await cookies();
  if (cookieStore.get(ROOT_MARKER_KEY)?.value !== "1") return null;

  return (
    <Link href={`${toAdminUrl(appUrl)}/dashboard/admin`} className={className}>
      Admin
    </Link>
  );
}
