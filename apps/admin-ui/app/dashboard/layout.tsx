'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { isAuthenticated, parseJwt, getAccessToken, startProactiveRefresh, stopProactiveRefresh } from '@/lib/auth';
import { api } from '@/lib/api';
import type { UserInfo, UserProfile } from '@/lib/types';
import { Header } from '@/components/header';

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

  useEffect(() => {
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
        Cookies.set('kb_active_team', teamId, { expires: 365 });
      } catch {}
    }

    init();

    return () => stopProactiveRefresh();
  }, [router]);

  const handleTeamChange = useCallback((id: string) => {
    setActiveTeamId(id);
    Cookies.set('kb_active_team', id, { expires: 365 });
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
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </DashboardContext.Provider>
  );
}
