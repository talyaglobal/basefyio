'use client';

import type { ElementType } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import Cookies from 'js-cookie';
import {
  ShieldCheck,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  LayoutDashboard,
  MessageSquareText,
  Rocket,
  Sparkles,
  Trophy,
  UserCircle,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import type { Team } from '@/lib/types';
import { useDashboard } from '@/app/dashboard/layout';

const COLLAPSED_KEY = 'basefyio_dashboard_nav_collapsed';
const SIDEBAR_MODE_KEY = 'basefyio_dashboard_sidebar_mode';
const EXPANDED_W = 220;
const COLLAPSED_W = 52;
type SidebarMode = 'auto' | 'open';

function isProjectDetailPath(pathname: string) {
  return /^\/dashboard\/projects\/[^/]+/.test(pathname);
}

type NavItem = {
  href: string;
  label: string;
  icon: ElementType;
  isActive: (pathname: string) => boolean;
};

const ALL_NAV_ITEMS: NavItem[] = [
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
    href: '/dashboard/billing',
    label: 'Billing',
    icon: CreditCard,
    isActive: (p) => p.startsWith('/dashboard/billing'),
  },
  {
    href: '/dashboard/account',
    label: 'Account',
    icon: UserCircle,
    isActive: (p) =>
      p.startsWith('/dashboard/profile') || p.startsWith('/dashboard/account'),
  },
  {
    href: '/dashboard/blueprints',
    label: 'App Builder',
    icon: Sparkles,
    isActive: (p) => p.startsWith('/dashboard/blueprints'),
  },
  {
    href: '/dashboard/feedbacks',
    label: 'Feedbacks',
    icon: MessageSquareText,
    isActive: (p) => p.startsWith('/dashboard/feedbacks'),
  },
];

const ROOT_NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard/management',
    label: 'Management',
    icon: ShieldCheck,
    isActive: (p) => p === '/dashboard/management',
  },
  {
    href: '/dashboard/management/gamification',
    label: 'Gamification',
    icon: Trophy,
    isActive: (p) => p.startsWith('/dashboard/management/gamification'),
  },
  {
    href: '/dashboard/management/go-to-market',
    label: 'Go-To-Market',
    icon: Rocket,
    isActive: (p) => p.startsWith('/dashboard/management/go-to-market'),
  },
];

export function DashboardSidebar({
  activeTeamId,
  refreshKey,
  isRoot = false,
  onTeamChange,
}: {
  activeTeamId: string;
  refreshKey: number;
  isRoot?: boolean;
  onTeamChange: (teamId: string, opts?: { source?: 'user-switch' | 'route-sync' }) => void;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { teams } = useDashboard();
  const team = teams.find((t) => t.id === activeTeamId) ?? null;
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('open');
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [teamDropdownOpen, setTeamDropdownOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    fetch('/api/changelog/latest')
      .then((r) => r.json())
      .then((d) => { if (d.version) setAppVersion(d.version); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    try {
      const m = localStorage.getItem(SIDEBAR_MODE_KEY);
      if (m === 'auto' || m === 'open') {
        setSidebarMode(m);
      } else {
        const legacyCollapsed = localStorage.getItem(COLLAPSED_KEY);
        setSidebarMode(legacyCollapsed === '1' ? 'auto' : 'open');
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    const onGlobalPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-sidebar-team-dropdown="true"]')) return;
      setTeamDropdownOpen(false);
    };
    document.addEventListener('mousedown', onGlobalPointerDown);
    return () => document.removeEventListener('mousedown', onGlobalPointerDown);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, sidebarMode);
      localStorage.setItem(COLLAPSED_KEY, sidebarMode === 'auto' ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [sidebarMode, hydrated]);

  const sortedTeams = useMemo(() => {
    return [...teams].sort((a, b) => a.name.localeCompare(b.name));
  }, [teams]);

  if (isProjectDetailPath(pathname)) {
    return null;
  }

  const collapsed = sidebarMode === 'auto' && !autoExpanded;
  const w = collapsed ? COLLAPSED_W : EXPANDED_W;
  const items = isRoot ? [...ALL_NAV_ITEMS, ...ROOT_NAV_ITEMS] : ALL_NAV_ITEMS;

  async function switchTeam(teamId: string) {
    try {
      await api.teams.setActive(teamId);
      Cookies.set('basefyio_active_team', teamId, { expires: 365, path: '/' });
      onTeamChange(teamId, { source: 'user-switch' });
      setTeamDropdownOpen(false);
      router.push('/dashboard/projects');
    } catch {
      // keep silent here; header/toast handles broader team switching UX
    }
  }

  return (
    <aside
      className={cn(
        'hidden md:flex shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ease-out',
        !hydrated && 'opacity-0',
        hydrated && 'opacity-100',
      )}
      style={{ width: w }}
      onMouseEnter={() => {
        if (sidebarMode === 'auto') setAutoExpanded(true);
      }}
      onMouseLeave={() => {
        if (sidebarMode === 'auto') setAutoExpanded(false);
      }}
    >

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
        {collapsed ? (
          <button
            type="button"
            onClick={() => setSidebarMode('open')}
            className="flex h-9 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Open sidebar"
            aria-label="Open sidebar"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : (
          <>
            <div className="flex items-center gap-1 rounded-md bg-muted/70 p-1">
              <button
                type="button"
                onClick={() => setSidebarMode('auto')}
                className={cn(
                  'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                  sidebarMode === 'auto'
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Auto
              </button>
              <button
                type="button"
                onClick={() => setSidebarMode('open')}
                className={cn(
                  'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                  sidebarMode === 'open'
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Open
              </button>
            </div>
            {appVersion && (
              <p className="mt-1 text-center text-[10px] italic text-muted-foreground/40">{appVersion}</p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
