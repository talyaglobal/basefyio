'use client';

import type { ElementType } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Box,
  ChevronLeft,
  ChevronRight,
  Home,
  LayoutDashboard,
  MessageSquareText,
  UserCircle,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { Team } from '@/lib/types';

const COLLAPSED_KEY = 'kb_dashboard_nav_collapsed';
const EXPANDED_W = 220;
const COLLAPSED_W = 52;

function isProjectDetailPath(pathname: string) {
  return /^\/dashboard\/projects\/[^/]+/.test(pathname);
}

const items: {
  href: string;
  label: string;
  icon: ElementType;
  isActive: (pathname: string) => boolean;
}[] = [
  {
    href: '/dashboard',
    label: 'Overview',
    icon: LayoutDashboard,
    isActive: (p) => p === '/dashboard',
  },
  {
    href: '/dashboard/projects',
    label: 'Projects',
    icon: Box,
    isActive: (p) => p === '/dashboard/projects',
  },
  {
    href: '/dashboard/team',
    label: 'Team',
    icon: Users,
    isActive: (p) => p.startsWith('/dashboard/team'),
  },
  {
    href: '/dashboard/profile',
    label: 'Account',
    icon: UserCircle,
    isActive: (p) =>
      p.startsWith('/dashboard/profile') || p.startsWith('/dashboard/account'),
  },
  {
    href: '/dashboard/feedbacks',
    label: 'Feedbacks',
    icon: MessageSquareText,
    isActive: (p) => p.startsWith('/dashboard/feedbacks'),
  },
];

export function DashboardSidebar({
  activeTeamId,
  refreshKey,
}: {
  activeTeamId: string;
  refreshKey: number;
}) {
  const pathname = usePathname() ?? '';
  const [collapsed, setCollapsed] = useState(false);
  const [team, setTeam] = useState<Team | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const v = localStorage.getItem(COLLAPSED_KEY);
      if (v === '1') setCollapsed(true);
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!activeTeamId) {
      setTeam(null);
      return;
    }
    api.teams
      .list()
      .then((teams) => setTeam(teams.find((t) => t.id === activeTeamId) ?? null))
      .catch(() => setTeam(null));
  }, [activeTeamId, refreshKey]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  if (isProjectDetailPath(pathname)) {
    return null;
  }

  const w = collapsed ? COLLAPSED_W : EXPANDED_W;

  return (
    <aside
      className={cn(
        'hidden md:flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ease-out',
        !hydrated && 'opacity-0',
        hydrated && 'opacity-100',
      )}
      style={{ width: w }}
    >
      {/* Breadcrumb / org row — Supabase-style */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2">
        <Link
          href="/dashboard"
          title="Dashboard home"
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            pathname === '/dashboard' && 'bg-muted text-foreground',
          )}
        >
          <Home className="h-4 w-4" />
        </Link>
        {!collapsed && (
          <>
            <span className="text-muted-foreground/50 text-xs">/</span>
            <div className="min-w-0 flex-1 flex items-center gap-1.5">
              <Link
                href="/dashboard/team"
                className="truncate text-sm font-medium text-foreground hover:underline underline-offset-2"
                title={team?.name ?? 'Team'}
              >
                {team?.name ?? '…'}
              </Link>
              {team?.role === 'OWNER' && (
                <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/25">
                  Owner
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-2 overflow-y-auto">
        {items.map(({ href, label, icon: Icon, isActive }) => {
          const active = isActive(pathname);
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors',
                active
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                collapsed && 'justify-center px-0',
              )}
            >
              <Icon className={cn('h-4 w-4 shrink-0', active && 'text-foreground')} />
              {!collapsed && <span className="truncate">{label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-border p-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title={collapsed ? 'Expand menu' : 'Collapse menu'}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4 shrink-0" />
              <span className="text-xs">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
