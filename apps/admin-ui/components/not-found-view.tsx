'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Database, FolderOpen, LayoutDashboard, RotateCcw, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface NotFoundAction {
  label: string;
  href: string;
  icon?: 'dashboard' | 'projects';
}

/**
 * The "page / project not found" state, used by the not-found pages and the
 * project layout. It replaces the bare framework 404 (no logo, no way back)
 * and the generic "Failed to load project" toast.
 */
export function NotFoundView({
  title = 'Page not found',
  description = 'The page you are looking for does not exist or has moved.',
  code = '404',
  actions = [
    { label: 'Go to dashboard', href: '/dashboard', icon: 'dashboard' },
    { label: 'All projects', href: '/dashboard/projects', icon: 'projects' },
  ],
  showBack = true,
  onRetry,
  fullPage = false,
}: {
  title?: string;
  description?: string;
  code?: string | null;
  actions?: NotFoundAction[];
  showBack?: boolean;
  /** Shown as "Try again" for failures that may be temporary. */
  onRetry?: () => void;
  /** Standalone page (outside the dashboard chrome): adds the basefyio logo. */
  fullPage?: boolean;
}) {
  const router = useRouter();

  const body = (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-16 text-center">
      <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
        <SearchX className="h-7 w-7 text-muted-foreground" aria-hidden />
      </div>
      {code && (
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Error {code}</p>
      )}
      <h1 className="mt-2 text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {onRetry && (
          <Button onClick={onRetry}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Try again
          </Button>
        )}
        {actions.map((action, i) => {
          const Icon = action.icon === 'projects' ? FolderOpen : action.icon === 'dashboard' ? LayoutDashboard : null;
          return (
            <Button key={action.href} variant={i === 0 && !onRetry ? 'default' : 'outline'} asChild>
              <Link href={action.href}>
                {Icon && <Icon className="mr-1.5 h-4 w-4" />}
                {action.label}
              </Link>
            </Button>
          );
        })}
        {showBack && (
          <Button variant="ghost" onClick={() => router.back()}>
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Go back
          </Button>
        )}
      </div>
    </div>
  );

  if (!fullPage) return body;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b bg-card/95">
        <div className="flex h-14 items-center px-4 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-md">
              <Database className="h-4 w-4" />
            </span>
            <span className="text-lg font-bold gradient-text">basefyio</span>
          </Link>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center">{body}</main>
    </div>
  );
}
