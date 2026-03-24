'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { clearTokens } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Team, UserInfo } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Bell,
  ChevronDown,
  Database,
  LogOut,
  MessageSquarePlus,
  Settings,
  User,
  Users,
} from 'lucide-react';
import { FeedbackModal } from '@/components/feedback-modal';

interface HeaderProps {
  user: UserInfo;
  activeTeamId: string | null;
  onTeamChange: (teamId: string) => void;
}

export function Header({ user, activeTeamId, onTeamChange }: HeaderProps) {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [inviteCount, setInviteCount] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    api.teams.list().then(setTeams).catch(() => {});
    api.teams.myInvites().then((inv) => setInviteCount(inv.length)).catch(() => {});
  }, [activeTeamId]);

  const activeTeam = teams.find((t) => t.id === activeTeamId);

  async function switchTeam(teamId: string) {
    try {
      await api.teams.setActive(teamId);
      Cookies.set('kb_active_team', teamId, { expires: 365 });
      onTeamChange(teamId);
      setDropdownOpen(false);
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function handleLogout() {
    clearTokens();
    Cookies.remove('kb_active_team');
    router.push('/login');
  }

  return (
    <header className="flex h-14 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-4">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Database className="h-4 w-4" />
          </div>
          <span className="text-lg font-bold">Kolaybase</span>
        </Link>

        {/* Team Switcher */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
          >
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="max-w-[160px] truncate">
              {activeTeam?.name || 'Select team'}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>

          {dropdownOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setDropdownOpen(false)}
              />
              <div className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border bg-card shadow-lg">
                <div className="p-1">
                  {teams.map((team) => (
                    <button
                      key={team.id}
                      onClick={() => switchTeam(team.id)}
                      className={`flex w-full items-center gap-3 rounded-sm px-3 py-2 text-sm transition-colors ${
                        team.id === activeTeamId
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'hover:bg-accent'
                      }`}
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded bg-muted text-xs font-bold">
                        {team.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 text-left">
                        <p className="truncate font-medium">{team.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {team.memberCount} member{team.memberCount !== 1 ? 's' : ''} · {team.projectCount} project{team.projectCount !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="border-t p-1">
                  <button
                    onClick={() => {
                      setDropdownOpen(false);
                      router.push('/dashboard/team');
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    Team Settings
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={() => setFeedbackOpen(true)}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Feedback</span>
        </Button>
      </div>

      <div className="flex items-center gap-3">
        {inviteCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="relative h-9"
            onClick={() => router.push('/dashboard/team')}
          >
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            {inviteCount} invite{inviteCount > 1 ? 's' : ''}
          </Button>
        )}

        <div className="relative">
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
              <User className="h-4 w-4 text-primary" />
            </div>
            <span className="hidden font-medium sm:inline">
              {user.preferred_username || user.email}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>

          {userMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setUserMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border bg-card shadow-lg">
                <div className="p-2 border-b">
                  <p className="text-sm font-medium truncate">
                    {user.preferred_username || user.email}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user.email}
                  </p>
                </div>
                <div className="p-1">
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      router.push('/dashboard/profile');
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent transition-colors"
                  >
                    <User className="h-3.5 w-3.5" />
                    Profile Settings
                  </button>
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      router.push('/dashboard/team');
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent transition-colors"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    Team Settings
                  </button>
                </div>
                <div className="border-t p-1">
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      handleLogout();
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-destructive hover:bg-accent transition-colors"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign Out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </header>
  );
}
