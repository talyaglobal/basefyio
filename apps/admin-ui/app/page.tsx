import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';

export default async function Home() {
  const cookieStore = await cookies();
  const isLoggedIn =
    !!cookieStore.get('kb_access_token')?.value ||
    !!cookieStore.get('kb_logged_in')?.value;

  redirect(isLoggedIn ? '/dashboard' : '/login');
}
