'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { clearTokens, stopProactiveRefresh, getRefreshToken } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Team, UserInfo } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Bell,
  Book,
  ChevronDown,
  Code,
  Database,
  ExternalLink,
  KeyRound,
  LogOut,
  MessageSquarePlus,
  Server,
  Settings,
  Terminal,
  User,
  Users,
} from 'lucide-react';
import { FeedbackModal } from '@/components/feedback-modal';
import type { UserProfile } from '@/lib/types';

interface HeaderProps {
  user: UserInfo;
  activeTeamId: string | null;
  onTeamChange: (teamId: string) => void;
  refreshKey?: number;
  profile?: UserProfile | null;
}

export function Header({ user, activeTeamId, onTeamChange, refreshKey = 0, profile }: HeaderProps) {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [inviteCount, setInviteCount] = useState(0);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    api.teams.list().then(setTeams).catch(() => {});
    api.teams.myInvites().then((inv) => setInviteCount(inv.length)).catch(() => {});
  }, [activeTeamId, refreshKey]);

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

  async function handleLogout() {
    // Stop the proactive refresh timer FIRST to prevent it from
    // restoring tokens after we clear them (race condition).
    stopProactiveRefresh();

    const refreshToken = getRefreshToken();

    // Clear local tokens and cookies before any async work so the UI
    // reflects the signed-out state immediately.
    clearTokens();
    Cookies.remove('kb_active_team');

    // Best-effort: revoke the Keycloak session so OAuth SSO sessions
    // are also terminated and the user can't be auto-re-authenticated.
    if (refreshToken) {
      await api.auth.logout(refreshToken).catch(() => {});
    }

    // Hard redirect (full page reload) guarantees all React state,
    // timers, and in-flight requests are fully discarded.
    window.location.href = '/login';
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

        <DocsMenu />
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

        <UserMenu user={user} profile={profile ?? null} onLogout={handleLogout} />
      </div>

      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </header>
  );
}

const docsBaseUrl = process.env.NEXT_PUBLIC_DOCS_URL || 'https://kolaybase.com';

const docsLinks = [
  { label: 'Overview', href: '/docs', icon: Book },
  { label: 'API Reference', href: '/docs/api', icon: Server },
  { label: 'SDK', href: '/docs/sdk', icon: Code },
  { label: 'CLI', href: '/docs/cli', icon: Terminal },
];

function DocsMenu() {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <Book className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Docs</span>
        <ChevronDown className="h-3 w-3" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-md border bg-card shadow-lg">
            <div className="p-1">
              {docsLinks.map((item) => (
                <a
                  key={item.href}
                  href={`${docsBaseUrl}${item.href}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-sm hover:bg-accent transition-colors"
                >
                  <item.icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {item.label}
                  <ExternalLink className="ml-auto h-3 w-3 text-muted-foreground/50" />
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu({ user, profile, onLogout }: { user: UserInfo; profile: UserProfile | null; onLogout: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const firstName = profile?.firstName ?? '';
  const lastName = profile?.lastName ?? '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || user.email;
  const initials = firstName && lastName
    ? `${firstName[0]}${lastName[0]}`.toUpperCase()
    : (firstName || user.email).slice(0, 2).toUpperCase();
  const avatarUrl = profile?.avatarUrl;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
      >
        {/* Avatar */}
        <div className="h-8 w-8 rounded-full overflow-hidden ring-1 ring-border shrink-0">
          {avatarUrl ? (
            <img src={avatarUrl} alt={displayName} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full bg-primary/10 flex items-center justify-center text-xs font-semibold text-primary">
              {initials}
            </div>
          )}
        </div>
        <span className="hidden max-w-[140px] truncate font-medium sm:inline">
          {displayName}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border bg-card shadow-lg">
            <div className="border-b px-3 py-2.5 flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-full overflow-hidden ring-1 ring-border shrink-0">
                {avatarUrl ? (
                  <img src={avatarUrl} alt={displayName} className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full bg-primary/10 flex items-center justify-center text-sm font-semibold text-primary">
                    {initials}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{displayName}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
            </div>
            <div className="p-1">
              <button
                onClick={() => { setOpen(false); router.push('/dashboard/account'); }}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm hover:bg-accent"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Account Settings
              </button>
            </div>
            <div className="border-t p-1">
              <button
                onClick={() => { setOpen(false); onLogout(); }}
                className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
