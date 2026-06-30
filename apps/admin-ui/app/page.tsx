import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

// Send signed-in visitors straight to the dashboard. The cross-subdomain
// `basefyio_logged_in` marker (set on .basefyio.com) is the reliable signal —
// the JWT cookie can be dropped past the ~4KB limit. Without this the root
// always bounced to /login, so opening app.basefyio.com in a new tab showed
// "Sign In" even with an active session.
export default async function Home() {
  const c = await cookies();
  const loggedIn =
    c.get('basefyio_logged_in')?.value === '1' ||
    !!c.get('basefyio_access_token')?.value;
  redirect(loggedIn ? '/dashboard' : '/login');
}
