'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, Database, FolderOpen, HardDrive, LayoutDashboard, LogOut, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { clearTokens } from '@/lib/auth';
import { resetSdk } from '@/lib/sdk';
import { HealthIndicator } from './health-indicator';
import { Button } from './ui/button';
import { Separator } from './ui/separator';

interface AppSidebarProps {
  projectId?: string;
}

export function AppSidebar({ projectId }: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  function handleLogout() {
    clearTokens();
    resetSdk();
    router.push('/login');
  }

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center gap-2 p-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Database className="h-4 w-4" />
        </div>
        <span className="font-semibold">basefyio</span>
      </div>

      <Separator />

      <nav className="flex-1 space-y-1 p-2">
        {projectId ? (
          <>
            <Link
              href="/dashboard/projects"
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              All projects
            </Link>
            <Separator className="my-1" />
            <NavItem href={`/dashboard/projects/${projectId}`} icon={LayoutDashboard} label="Overview" active={pathname === `/dashboard/projects/${projectId}`} />
            <NavItem href={`/dashboard/projects/${projectId}/sql`} icon={Terminal} label="SQL Editor" active={pathname.startsWith(`/dashboard/projects/${projectId}/sql`)} />
            <NavItem href={`/dashboard/projects/${projectId}/storage`} icon={HardDrive} label="Storage" active={pathname.startsWith(`/dashboard/projects/${projectId}/storage`)} />
          </>
        ) : (
          <NavItem href="/dashboard/projects" icon={FolderOpen} label="Projects" active={pathname.startsWith('/dashboard/projects')} />
        )}
      </nav>

      <Separator />
      <div className="space-y-2 p-3">
        <HealthIndicator />
        <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" onClick={handleLogout}>
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  );
}

function NavItem({
  href,
  icon: Icon,
  label,
  active,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}
