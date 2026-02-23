'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { clearTokens } from '@/lib/auth';
import type { UserInfo } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Database, LogOut, User } from 'lucide-react';

interface HeaderProps {
  user: UserInfo;
}

export function Header({ user }: HeaderProps) {
  const router = useRouter();

  function handleLogout() {
    clearTokens();
    router.push('/login');
  }

  return (
    <header className="flex h-14 items-center justify-between border-b bg-card px-6">
      <Link href="/dashboard" className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Database className="h-4 w-4" />
        </div>
        <span className="text-lg font-bold">Kolaybase</span>
      </Link>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
            <User className="h-4 w-4 text-primary" />
          </div>
          <span className="hidden font-medium sm:inline">
            {user.preferred_username || user.email}
          </span>
        </div>

        <Button variant="ghost" size="icon" onClick={handleLogout}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
