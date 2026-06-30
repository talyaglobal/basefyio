'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Database } from 'lucide-react';
import { cn } from '@/lib/utils';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/dashboard/projects', label: 'Projects' },
  { href: '/playground', label: 'Playground' },
  { href: 'https://github.com/myfyio/basefyio', label: 'Docs', external: true },
];

export function PlaygroundNav() {
  const pathname = usePathname();
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b bg-card px-4">
      <div className="flex items-center gap-6">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Database className="h-4 w-4" />
          </div>
          <span className="font-semibold">basefyio</span>
        </Link>
        <nav className="flex items-center gap-1">
          {LINKS.map((l) => {
            const active = !l.external && (l.href === '/playground'
              ? pathname.startsWith('/playground')
              : pathname === l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                target={l.external ? '_blank' : undefined}
                rel={l.external ? 'noreferrer' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <Link
        href="/login"
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Sign in
      </Link>
    </header>
  );
}
