'use client';

import type { ElementType, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  BarChart3,
  Box,
  ExternalLink,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Rocket,
  Search,
  ShieldCheck,
  Trophy,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { api } from '@/lib/api';
import {
  clearTokens,
  getAccessToken,
  getIdToken,
  getRefreshToken,
  setRootMarker,
  startProactiveRefresh,
} from '@/lib/auth';
import type { UserProfile } from '@/lib/types';
import { DashboardContext } from '@/app/dashboard/layout';
import { cn } from '@/lib/utils';

type NavItem = { href: string; label: string; icon: ElementType; exact?: boolean };

const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Platform',
    items: [
      { href: '/console', label: 'Overview', icon: LayoutDashboard, exact: true },
      { href: '/console/projects', label: 'Projects', icon: Box },
      { href: '/console/storage', label: 'Storage', icon: HardDrive },
      { href: '/console/costs', label: 'Infrastructure costs', icon: Wallet },
    ],
  },
  {
    group: 'Operations',
    items: [{ href: '/console/manage', label: 'Users & billing', icon: ShieldCheck }],
  },
  {
    group: 'Growth',
    items: [
      { href: '/console/marketing-strategy', label: 'Marketing strategy', icon: TrendingUp },
      { href: '/console/go-to-market', label: 'Go-to-market', icon: Rocket },
      { href: '/console/seo', label: 'SEO manager', icon: Search },
      { href: '/console/marketing-agency', label: 'Marketing agency', icon: Megaphone },
      { href: '/console/gamification', label: 'Gamification', icon: Trophy },
    ],
  },
];

/** The customer app on the sibling host; same origin when running locally. */
function appUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  const host = window.location.hostname;
  return host.startsWith('admin.') ? `https://app.${host.slice('admin.'.length)}${path}` : path;
}

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/console';
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    if (!getAccessToken() && !getRefreshToken()) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }
    startProactiveRefresh();
    api.auth
      .getProfile()
      .then((p) => {
        if (p.role !== 'ROOT') {
          // The console is root-only; everyone else belongs in the app.
          window.location.replace(appUrl('/dashboard'));
          return;
        }
        setRootMarker(true);
        setProfile(p);
      })
      .catch(() => {
        // A rejected session is handled by the API client (back to /login);
        // a transient failure leaves the spinner up rather than logging out.
      });
  }, [router]);

  const contextValue = useMemo(
    () => ({
      activeTeamId: '',
      setActiveTeamId: () => {},
      viewTeamId: 'all',
      setViewTeamId: () => {},
      refreshUser: () => {},
      refreshKey: 0,
      refreshTeams: () => {},
      profile,
      refreshProfile: () => {
        api.auth.getProfile().then(setProfile).catch(() => {});
      },
      teams: [],
      inviteCount: 0,
    }),
    [profile],
  );

  function signOut() {
    const refreshToken = getRefreshToken();
    const idToken = getIdToken();
    clearTokens();
    if (refreshToken) api.auth.logout(refreshToken, undefined, idToken).catch(() => {});
    window.location.href = '/login?handoff=none';
  }

  if (!profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <DashboardContext.Provider value={contextValue}>
      <div className="min-h-screen bg-muted/30">
        {/* Fixed, not sticky: html/body set overflow-x hidden, which breaks sticky. */}
        <aside className="fixed inset-y-0 left-0 z-30 flex w-60 flex-col bg-zinc-950 text-zinc-300">
          <div className="flex items-center gap-2.5 px-4 py-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
              <BarChart3 className="h-4 w-4 text-white" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-white">basefyio</div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500">Root console</div>
            </div>
          </div>

          <nav className="flex-1 space-y-5 overflow-y-auto px-2 pb-4">
            {NAV.map((section) => (
              <div key={section.group}>
                <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {section.group}
                </div>
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const active = isActive(item);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                          'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                          active ? 'bg-white/10 font-medium text-white' : 'hover:bg-white/5 hover:text-white',
                        )}
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="space-y-1 border-t border-white/10 p-3 text-sm">
            <div className="truncate px-2 pb-1 text-xs text-zinc-500" title={profile.email}>
              {profile.email}
            </div>
            <a
              href={appUrl('/dashboard')}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-white/5 hover:text-white"
            >
              <ExternalLink className="h-4 w-4" />
              Open the app
            </a>
            <button
              onClick={signOut}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-white/5 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </aside>

        <main className="min-w-0 pl-60">
          <div className="mx-auto max-w-[1600px] px-6 py-8">{children}</div>
        </main>
      </div>
    </DashboardContext.Provider>
  );
}
