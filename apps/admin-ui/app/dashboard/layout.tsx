'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated, parseJwt, getAccessToken } from '@/lib/auth';
import type { UserInfo } from '@/lib/types';
import { Header } from '@/components/header';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);

  useEffect(() => {
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }

    const token = getAccessToken();
    if (token) {
      setUser(parseJwt(token));
    }
  }, [router]);

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header user={user} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
