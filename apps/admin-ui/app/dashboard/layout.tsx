'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { CreditCard } from 'lucide-react';
import { isAuthenticated, parseJwt, getAccessToken, startProactiveRefresh, stopProactiveRefresh } from '@/lib/auth';
import { api } from '@/lib/api';
import type { UserInfo, UserProfile } from '@/lib/types';
import { Header } from '@/components/header';
import { AiAssistant } from '@/components/ai-assistant';
import { DashboardSidebar } from '@/components/dashboard-sidebar';
import { subscribeKbRealtime, isRealtimePhase1Enabled } from '@/lib/supabase-realtime';
import type { RealtimeEventEnvelope } from '@/lib/realtime-types';

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
  const [billingBanner, setBillingBanner] = useState<{
    planName: string;
    type: 'warning' | 'error';
    message: string;
    action: string;
  } | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const pathname = usePathname();
  const isProjectDetailRoute =
    pathname.startsWith('/dashboard/projects/') &&
    pathname !== '/dashboard/projects';

  useEffect(() => {
    const forcePasswordChange = Cookies.get('kb_force_password_change') === '1';
    if (forcePasswordChange) {
      router.replace('/set-new-password');
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

    let cancelled = false;

    async function init() {
      await api.auth.me().catch(() => {});

      if (cancelled) return;

      api.auth
        .getProfile()
        .then((p) => {
          if (cancelled) return;
          setProfile(p);
          if (p.forcePasswordChange) {
            Cookies.set('kb_force_password_change', '1', { expires: 7, path: '/' });
            router.replace('/set-new-password');
          }
        })
        .catch(() => {});

      const cachedTeam = Cookies.get('kb_active_team');

      if (cachedTeam) {
        try {
          const teams = await api.teams.list();
          if (cancelled) return;
          const valid = teams.some((t) => t.id === cachedTeam);
          if (valid) {
            setActiveTeamId(cachedTeam);
            return;
          }
        } catch {}
        if (cancelled) return;
        Cookies.remove('kb_active_team');
      }

      try {
        const { teamId } = await api.teams.getActive();
        if (!cancelled) {
          setActiveTeamId(teamId);
          Cookies.set('kb_active_team', teamId, { expires: 365, path: '/' });
        }
      } catch {}
    }

    init();

    return () => {
      cancelled = true;
      stopProactiveRefresh();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (!activeTeamId) return;
    
    let isMounted = true;
    
    api.billing.subscription(activeTeamId).then((sub: any) => {
      if (!isMounted || !sub?.plan) return;

      const isPaidPlan = sub.plan.priceMonthly > 0 && sub.plan.name !== 'legacy';
      const hasPaymentMethod = sub.hasPaymentMethod === true;
      const accountStatus = sub.accountStatus || 'ACTIVE';
      const subscriptionStatus = sub.status || 'ACTIVE';

      // FROZEN accounts: restrict access to certain pages only
      // Allow: billing, projects (read-only), overview
      // Block: team settings, management, feedback
      const allowedPaths = ['/dashboard/billing', '/dashboard/projects', '/dashboard'];
      const isAllowedPath = allowedPaths.some(path => pathname === path || pathname.startsWith(path));
      
      if (accountStatus === 'FROZEN' && !isAllowedPath) {
        router.replace('/dashboard/billing');
        toast.error('Your account is suspended. Please update your payment method to access this page.');
        return;
      }

      // Determine banner type and message
      if (accountStatus === 'FROZEN') {
        setBillingBanner({
          planName: sub.plan.displayName,
          type: 'error',
          message: 'Account suspended due to payment failure. Please update your payment method.',
          action: 'Retry Payment',
        });
      } else if (subscriptionStatus === 'PAST_DUE' && isPaidPlan) {
        setBillingBanner({
          planName: sub.plan.displayName,
          type: 'warning',
          message: 'Payment failed. Please update your payment method to avoid service interruption.',
          action: 'Update Card',
        });
      } else if (isPaidPlan && !hasPaymentMethod) {
        setBillingBanner({
          planName: sub.plan.displayName,
          type: 'warning',
          message: 'Add a payment method to keep your subscription active.',
          action: 'Add Payment Method',
        });
      } else {
        // Everything is OK, no banner
        setBillingBanner(null);
      }
    }).catch((err) => {
      // Don't break the page if billing API fails
      console.error('Failed to load billing subscription:', err);
      setBillingBanner(null);
    });
    
    return () => {
      isMounted = false;
    };
  }, [activeTeamId, pathname, router]);

  const handleTeamChange = useCallback((id: string) => {
    setActiveTeamId(id);
    Cookies.set('kb_active_team', id, { expires: 365, path: '/' });
  }, []);

  const handleHeaderTeamChange = useCallback(
    (id: string, opts?: { source?: 'user-switch' | 'route-sync' }) => {
      handleTeamChange(id);
      const source = opts?.source ?? 'user-switch';
      const isProjectDetailPage =
        pathname.startsWith('/dashboard/projects/') && pathname !== '/dashboard/projects';
      if (source === 'user-switch' && isProjectDetailPage) {
        router.push('/dashboard/projects');
      }
    },
    [handleTeamChange, pathname, router],
  );

  const refreshUser = useCallback(() => {
    api.auth.getProfile().then((p) => {
      setProfile(p);
      if (p.forcePasswordChange) {
        Cookies.set('kb_force_password_change', '1', { expires: 7, path: '/' });
        router.replace('/set-new-password');
      } else {
        Cookies.remove('kb_force_password_change', { path: '/' });
      }
      setUser((prev) =>
        prev ? { ...prev, preferred_username: p.username, email: p.email } : prev,
      );
    }).catch(() => {});
  }, [router]);

  const refreshProfile = useCallback(() => {
    api.auth.getProfile().then(setProfile).catch(() => {});
  }, []);

  const refreshTeams = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!activeTeamId) return;
    if (!isRealtimePhase1Enabled()) return;
    const unsubscribe = subscribeKbRealtime(`team:${activeTeamId}`, (event: RealtimeEventEnvelope) => {
      if (event.teamId !== activeTeamId) return;
      setRefreshKey((k) => k + 1);
    });
    return () => {
      unsubscribe?.();
    };
  }, [activeTeamId]);

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
        <Header user={user} activeTeamId={activeTeamId} onTeamChange={handleHeaderTeamChange} refreshKey={refreshKey} profile={profile} />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <DashboardSidebar
            activeTeamId={activeTeamId}
            refreshKey={refreshKey}
            isRoot={profile?.role === 'ROOT'}
            onTeamChange={handleHeaderTeamChange}
          />
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            {billingBanner && !bannerDismissed && !pathname.includes('/billing') && (
              <div className={`flex items-center justify-between gap-4 border-b px-6 py-3 ${
                billingBanner.type === 'error'
                  ? 'bg-red-950/40 border-red-800/50'
                  : 'bg-amber-950/40 border-amber-800/50'
              }`}>
                <div className={`flex items-center gap-3 text-sm ${
                  billingBanner.type === 'error' ? 'text-red-200' : 'text-amber-200'
                }`}>
                  <CreditCard className="h-4 w-4 shrink-0" />
                  <span>
                    <strong>{billingBanner.planName}</strong> plan: {billingBanner.message}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Link
                    href="/dashboard/billing"
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors ${
                      billingBanner.type === 'error'
                        ? 'bg-red-600 hover:bg-red-500'
                        : 'bg-amber-600 hover:bg-amber-500'
                    }`}
                  >
                    {billingBanner.action}
                  </Link>
                  <button
                    onClick={() => setBannerDismissed(true)}
                    className={`text-xs ${
                      billingBanner.type === 'error'
                        ? 'text-red-400 hover:text-red-200'
                        : 'text-amber-400 hover:text-amber-200'
                    }`}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            <div
              className={
                isProjectDetailRoute
                  ? 'flex h-full min-h-0 flex-1 p-3 sm:p-4 md:p-6'
                  : 'flex-1 p-3 sm:p-4 md:p-6'
              }
            >
              {children}
            </div>
          </main>
          <AiAssistant />
        </div>
      </div>
    </DashboardContext.Provider>
  );
}
