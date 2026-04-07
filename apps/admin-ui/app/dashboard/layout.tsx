'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Cookies from 'js-cookie';
import { CreditCard } from 'lucide-react';
import { isAuthenticated, parseJwt, getAccessToken, startProactiveRefresh, stopProactiveRefresh } from '@/lib/auth';
import { api } from '@/lib/api';
import type { UserInfo, UserProfile } from '@/lib/types';
import { Header } from '@/components/header';
import { AiAssistant } from '@/components/ai-assistant';
import { DashboardSidebar } from '@/components/dashboard-sidebar';

interface DashboardContextValue {
  activeTeamId: string;
  setActiveTeamId: (id: string) => void;
  refreshUser: () => void;
  refreshKey: number;
  refreshTeams: () => void;
  profile: UserProfile | null;
  refreshProfile: () => void;
}

export const DashboardContext = createContext<DashboardContextValue>({
  activeTeamId: '',
  setActiveTeamId: () => {},
  refreshUser: () => {},
  refreshKey: 0,
  refreshTeams: () => {},
  profile: null,
  refreshProfile: () => {},
});

export function useActiveTeam() {
  return useContext(DashboardContext);
}

export function useDashboard() {
  return useContext(DashboardContext);
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [billingBanner, setBillingBanner] = useState<{ planName: string } | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const forcePasswordChange = Cookies.get('kb_force_password_change') === '1';
    if (forcePasswordChange && pathname !== '/dashboard/account') {
      router.replace('/dashboard/account?forcePasswordChange=1');
      return;
    }
    if (!isAuthenticated()) {
      router.replace('/login');
      return;
    }

    const token = getAccessToken();
    if (token) {
      setUser(parseJwt(token));
      startProactiveRefresh();
    }

    async function init() {
      await api.auth.me().catch(() => {});

      // Load profile for navbar
      api.auth.getProfile().then(setProfile).catch(() => {});

      const cachedTeam = Cookies.get('kb_active_team');

      if (cachedTeam) {
        try {
          const teams = await api.teams.list();
          const valid = teams.some((t) => t.id === cachedTeam);
          if (valid) {
            setActiveTeamId(cachedTeam);
            return;
          }
        } catch {}
        Cookies.remove('kb_active_team');
      }

      try {
        const { teamId } = await api.teams.getActive();
        setActiveTeamId(teamId);
        Cookies.set('kb_active_team', teamId, { expires: 365, path: '/' });
      } catch {}
    }

    init();

    return () => stopProactiveRefresh();
  }, [router, pathname]);

  useEffect(() => {
    if (!activeTeamId) return;
    api.billing.subscription(activeTeamId).then((sub: any) => {
      if (!sub?.plan) return;
      const isPaid = sub.plan.priceMonthly > 0 && sub.plan.name !== 'legacy';
      const hasStripeSubscription = !!sub.stripeSubscriptionId;
      if (isPaid && !hasStripeSubscription) {
        setBillingBanner({ planName: sub.plan.displayName });
      } else {
        setBillingBanner(null);
      }
    }).catch(() => {});
  }, [activeTeamId]);

  const handleTeamChange = useCallback((id: string) => {
    setActiveTeamId(id);
    Cookies.set('kb_active_team', id, { expires: 365, path: '/' });
  }, []);

  const refreshUser = useCallback(() => {
    api.auth.getProfile().then((p) => {
      setProfile(p);
      setUser((prev) =>
        prev ? { ...prev, preferred_username: p.username, email: p.email } : prev,
      );
    }).catch(() => {});
  }, []);

  const refreshProfile = useCallback(() => {
    api.auth.getProfile().then(setProfile).catch(() => {});
  }, []);

  const refreshTeams = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  if (!user || !activeTeamId) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <DashboardContext.Provider value={{ activeTeamId, setActiveTeamId: handleTeamChange, refreshKey, refreshTeams, refreshUser, profile, refreshProfile }}>
      <div className="flex h-screen flex-col overflow-hidden">
        <Header user={user} activeTeamId={activeTeamId} onTeamChange={handleTeamChange} refreshKey={refreshKey} profile={profile} />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <DashboardSidebar
            activeTeamId={activeTeamId}
            refreshKey={refreshKey}
            isRoot={profile?.role === 'ROOT'}
          />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            {billingBanner && !bannerDismissed && !pathname.includes('/billing') && (
              <div className="flex items-center justify-between gap-4 bg-amber-950/40 border-b border-amber-800/50 px-6 py-3">
                <div className="flex items-center gap-3 text-sm text-amber-200">
                  <CreditCard className="h-4 w-4 shrink-0" />
                  <span>
                    You&apos;re on the <strong>{billingBanner.planName}</strong> plan. Add a payment method to keep your subscription active.
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Link
                    href="/dashboard/billing"
                    className="rounded-lg bg-amber-600 hover:bg-amber-500 px-3 py-1.5 text-xs font-medium text-white transition-colors"
                  >
                    Add Payment Method
                  </Link>
                  <button
                    onClick={() => setBannerDismissed(true)}
                    className="text-amber-400 hover:text-amber-200 text-xs"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            <div className="flex-1 p-3 sm:p-4 md:p-6">
              {children}
            </div>
          </main>
          <AiAssistant />
        </div>
      </div>
    </DashboardContext.Provider>
  );
}
