'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { clearTokens, stopProactiveRefresh, getRefreshToken, getIdToken } from '@/lib/auth';
import { api } from '@/lib/api';
import type { Project, ProjectListItem, Team, UserInfo } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Bell,
  Book,
  ChevronDown,
  Code,
  Database,
  ExternalLink,
  FolderOpen,
  KeyRound,
  LayoutDashboard,
  List,
  LogOut,
  MessageSquarePlus,
  Plus,
  Search,
  Server,
  Settings,
  Terminal,
  User,
  Users,
  Menu,
  ShieldCheck,
  X,
} from 'lucide-react';
import { FeedbackModal } from '@/components/feedback-modal';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationsBell } from '@/components/notifications-bell';
import type { UserProfile } from '@/lib/types';
import { useDashboard } from '@/app/dashboard/layout';
import { useProject } from '@/contexts/project-context';
import { cn } from '@/lib/utils';

interface HeaderProps {
  user: UserInfo;
  activeTeamId: string | null;
  onTeamChange: (teamId: string, opts?: { source?: 'user-switch' | 'route-sync' }) => void;
  refreshKey?: number;
  profile?: UserProfile | null;
}

function projectToListItem(p: Project): ProjectListItem {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    status: p.status,
    folderId: null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Project row for global header search (all teams) */
type ProjectForHeaderSearch = ProjectListItem & { teamId: string; teamName: string };

export function Header({ user, activeTeamId, onTeamChange, refreshKey = 0, profile }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const activeTeamIdRef = useRef(activeTeamId);
  activeTeamIdRef.current = activeTeamId;
  const headerSearchInputDesktopRef = useRef<HTMLInputElement | null>(null);
  const headerSearchInputMobileRef = useRef<HTMLInputElement | null>(null);

  const { teams, inviteCount } = useDashboard();
  // Read the current project from context (populated by ProjectLayout) — no extra fetch needed
  const { project: contextProject } = useProject();
  const [teamProjects, setTeamProjects] = useState<ProjectListItem[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectsMenuOpen, setProjectsMenuOpen] = useState(false);
  const [docsMenuOpen, setDocsMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [teamSearch, setTeamSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [headerProjectQuery, setHeaderProjectQuery] = useState('');
  const [headerSearchFocused, setHeaderSearchFocused] = useState(false);
  const [headerMobileSearchOpen, setHeaderMobileSearchOpen] = useState(false);
  const [allTeamsHeaderProjects, setAllTeamsHeaderProjects] = useState<ProjectForHeaderSearch[]>([]);
  const [allTeamsHeaderSearchLoading, setAllTeamsHeaderSearchLoading] = useState(false);

  useEffect(() => {
    const onGlobalPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-nav-dropdown-root="true"]')) return;
      if (target.closest('[data-header-project-search="true"]')) return;
      setDropdownOpen(false);
      setProjectsMenuOpen(false);
      setDocsMenuOpen(false);
      setUserMenuOpen(false);
      setHeaderMobileSearchOpen(false);
      setHeaderSearchFocused(false);
      setHeaderProjectQuery('');
    };
    document.addEventListener('mousedown', onGlobalPointerDown);
    return () => {
      document.removeEventListener('mousedown', onGlobalPointerDown);
    };
  }, []);

  useEffect(() => {
    if (!activeTeamId) {
      setTeamProjects([]);
      return;
    }
    setProjectsLoading(true);
    api.projects
      .list(activeTeamId)
      .then((list) =>
        setTeamProjects(list.filter((p) => p.status === 'ACTIVE')),
      )
      .catch(() => setTeamProjects([]))
      .finally(() => setProjectsLoading(false));
  }, [activeTeamId, refreshKey]);

  /** Load active projects from every team the user belongs to (navbar search). */
  useEffect(() => {
    if (!teams.length) {
      setAllTeamsHeaderProjects([]);
      return;
    }
    let cancelled = false;
    setAllTeamsHeaderSearchLoading(true);
    void Promise.all(
      teams.map((team) =>
        api.projects
          .list(team.id)
          .then((list) =>
            list
              .filter((p) => p.status === 'ACTIVE')
              .map(
                (p): ProjectForHeaderSearch => ({
                  ...p,
                  teamId: team.id,
                  teamName: team.name,
                }),
              ),
          )
          .catch(() => [] as ProjectForHeaderSearch[]),
      ),
    )
      .then((chunks) => {
        if (cancelled) return;
        setAllTeamsHeaderProjects(chunks.flat());
      })
      .finally(() => {
        if (!cancelled) setAllTeamsHeaderSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teams, refreshKey]);

  const currentProjectIdFromPath = pathname.startsWith('/dashboard/projects/')
    ? pathname.slice('/dashboard/projects/'.length).split('/')[0] || null
    : null;

  // Derive routeProject from context — ProjectLayout already fetched it, no second request needed
  const routeProject = contextProject?.id === currentProjectIdFromPath ? contextProject : null;

  // Sync active team when the route project belongs to a different team
  useEffect(() => {
    if (!routeProject) return;
    if (routeProject.teamId === activeTeamIdRef.current) return;
    (async () => {
      try {
        await api.teams.setActive(routeProject.teamId);
        Cookies.set('kb_active_team', routeProject.teamId, { expires: 365 });
        onTeamChange(routeProject.teamId, { source: 'route-sync' });
      } catch {
        /* keep header label even if team switch fails */
      }
    })();
  }, [routeProject, onTeamChange]);

  const activeTeam = teams.find((t) => t.id === activeTeamId);

  const currentProjectInTeam = currentProjectIdFromPath
    ? teamProjects.find((p) => p.id === currentProjectIdFromPath)
    : null;

  const projectsMenuLabel =
    routeProject?.id === currentProjectIdFromPath
      ? routeProject.name
      : currentProjectInTeam
        ? currentProjectInTeam.name
        : 'Projects';

  const menuProjects = useMemo(() => {
    const list = [...teamProjects];
    if (
      routeProject?.id === currentProjectIdFromPath &&
      !list.some((x) => x.id === routeProject.id)
    ) {
      list.unshift(projectToListItem(routeProject));
    }
    return list;
  }, [teamProjects, routeProject, currentProjectIdFromPath]);

  const filteredTeams = useMemo(() => {
    const q = teamSearch.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter((team) => team.name.toLowerCase().includes(q));
  }, [teams, teamSearch]);

  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return menuProjects;
    return menuProjects.filter((project) => {
      const name = project.name.toLowerCase();
      const slug = project.slug.toLowerCase();
      return name.includes(q) || slug.includes(q);
    });
  }, [menuProjects, projectSearch]);

  /** Merged list for global search; route project added if not already listed */
  const headerSearchBasePool = useMemo(() => {
    const byId = new Map<string, ProjectForHeaderSearch>();
    for (const p of allTeamsHeaderProjects) {
      byId.set(p.id, p);
    }
    if (routeProject?.id === currentProjectIdFromPath && !byId.has(routeProject.id)) {
      const t = teams.find((x) => x.id === routeProject.teamId);
      byId.set(routeProject.id, {
        ...projectToListItem(routeProject),
        teamId: routeProject.teamId,
        teamName: t?.name ?? 'Team',
      });
    }
    return Array.from(byId.values());
  }, [allTeamsHeaderProjects, routeProject, currentProjectIdFromPath, teams]);

  /** Header search: project name only, all teams */
  const headerSearchResults = useMemo(() => {
    const q = headerProjectQuery.trim().toLowerCase();
    const list = headerSearchBasePool;
    if (!q) {
      return [...list].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12);
    }
    return list
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [headerSearchBasePool, headerProjectQuery]);

  const closeHeaderProjectSearch = useCallback(() => {
    setHeaderProjectQuery('');
    setHeaderSearchFocused(false);
    setHeaderMobileSearchOpen(false);
    headerSearchInputDesktopRef.current?.blur();
    headerSearchInputMobileRef.current?.blur();
  }, []);

  const openHeaderMobileSearch = () => {
    setDropdownOpen(false);
    setProjectsMenuOpen(false);
    setDocsMenuOpen(false);
    setUserMenuOpen(false);
    setHeaderMobileSearchOpen(true);
  };

  const showHeaderSearchDropdown =
    teams.length > 0 && (headerSearchFocused || headerProjectQuery.trim().length > 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!headerSearchFocused && !headerMobileSearchOpen && !headerProjectQuery.trim()) return;
      e.preventDefault();
      closeHeaderProjectSearch();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [headerSearchFocused, headerMobileSearchOpen, headerProjectQuery, closeHeaderProjectSearch]);

  useLayoutEffect(() => {
    if (!headerMobileSearchOpen) return;
    window.requestAnimationFrame(() => {
      headerSearchInputMobileRef.current?.focus();
    });
  }, [headerMobileSearchOpen]);

  async function switchTeam(teamId: string) {
    try {
      await api.teams.setActive(teamId);
      Cookies.set('kb_active_team', teamId, { expires: 365 });
      onTeamChange(teamId, { source: 'user-switch' });
      setDropdownOpen(false);
      setProjectsMenuOpen(false);
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleCreateTeam() {
    if (!newTeamName.trim()) return;
    setCreatingTeam(true);
    try {
      const team = await api.teams.create(newTeamName.trim());
      await api.teams.setActive(team.id);
      import('js-cookie').then(({ default: Cookies }) => {
        Cookies.set('kb_active_team', team.id, { expires: 365 });
      });
      onTeamChange(team.id, { source: 'user-switch' });
      setNewTeamName('');
      setNewTeamOpen(false);
      setDropdownOpen(false);
      toast.success(`Team "${team.name}" created`);
    } catch (err: any) {
      toast.error(err.message || 'Failed to create team');
    } finally {
      setCreatingTeam(false);
    }
  }

  async function handleLogout() {
    // Stop the proactive refresh timer FIRST to prevent it from
    // restoring tokens after we clear them (race condition).
    stopProactiveRefresh();

    const refreshToken = getRefreshToken();
    const idToken = getIdToken();

    // Clear local tokens and cookies before any async work so the UI
    // reflects the signed-out state immediately.
    clearTokens();
    Cookies.remove('kb_active_team');

    // Revoke tokens and clear Keycloak browser SSO so another Google/GitHub account can sign in.
    if (refreshToken) {
      const redirectUri =
        typeof window !== 'undefined'
          ? `${window.location.origin}/login`
          : undefined;
      try {
        const res = await api.auth.logout(refreshToken, redirectUri, idToken);
        if (res.logoutUrl) {
          window.location.href = res.logoutUrl;
          return;
        }
      } catch {
        // fall through to /login
      }
    }

    window.location.href = '/login';
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between px-3 sm:px-4 md:px-6 bg-card/95 backdrop-blur-sm border-b border-border shadow-sm">
      {/* ── Left: logo + nav ─────────────────────────────────────── */}
      <div className="flex min-w-0 items-center gap-2 sm:gap-3 md:gap-4">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-md">
            <Database className="h-4 w-4" />
          </div>
          <span className="hidden text-lg font-bold gradient-text sm:inline">Kolaybase</span>
        </Link>

        {/* Primary nav links */}
        <nav className="hidden md:flex items-center gap-1">
          <Link
            href="/dashboard"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            Dashboard
          </Link>
          <Link
            href="/dashboard/projects"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Projects
          </Link>
          {profile?.role === 'ROOT' && (
            <Link
              href="/dashboard/management"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Management
            </Link>
          )}
        </nav>

        <Button
          variant="ghost"
          size="sm"
          className="hidden h-8 gap-1.5 text-muted-foreground hover:text-foreground sm:inline-flex"
          onClick={() => { closeHeaderProjectSearch(); setFeedbackOpen(true); }}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Feedback</span>
        </Button>
        <div className="hidden md:block">
          <DocsMenu
            open={docsMenuOpen}
            onOpenChange={(next) => {
              setDocsMenuOpen(next);
              if (next) {
                setDropdownOpen(false);
                setProjectsMenuOpen(false);
                setUserMenuOpen(false);
                closeHeaderProjectSearch();
              }
            }}
          />
        </div>
      </div>

      {/* ── Center: project search (all teams, project name only) ── */}
      <div
        className="flex min-w-0 flex-1 items-center justify-center px-1 sm:px-2"
        data-header-project-search="true"
      >
        <button
          type="button"
          className="relative flex w-full min-w-0 max-w-sm items-center gap-2 rounded-lg border border-input bg-muted/30 py-2 pl-3 pr-3 text-left text-sm text-muted-foreground shadow-sm transition-[box-shadow,background-color] hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring/30 lg:hidden"
          onClick={() => teams.length > 0 && openHeaderMobileSearch()}
          disabled={!teams.length}
          title={
            teams.length
              ? 'Search project names in all teams you belong to'
              : 'Create a team to search projects'
          }
        >
          <Search className="h-4 w-4 shrink-0 opacity-70" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Search projects by name…</span>
        </button>

        <div className="relative hidden w-full min-w-0 max-w-md lg:block">
          <label htmlFor="header-project-search-desktop" className="sr-only">
            Search projects by name across all your teams
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            id="header-project-search-desktop"
            ref={headerSearchInputDesktopRef}
            type="search"
            value={headerProjectQuery}
            onChange={(e) => setHeaderProjectQuery(e.target.value)}
            onFocus={() => setHeaderSearchFocused(true)}
            onBlur={() => {
              window.setTimeout(() => setHeaderSearchFocused(false), 150);
            }}
            placeholder="Search projects by name…"
            title="Searches project names in every team you belong to (not team names or descriptions)"
            autoComplete="off"
            autoCorrect="off"
            disabled={!teams.length}
            className={cn(
              'h-10 w-full min-w-0 rounded-lg border border-input bg-background pl-10 pr-10 text-sm shadow-sm',
              'placeholder:text-muted-foreground/85',
              'focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30',
              !teams.length && 'cursor-not-allowed opacity-50',
            )}
          />
          {headerProjectQuery ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setHeaderProjectQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
          {showHeaderSearchDropdown && (
            <div
              className="absolute left-0 top-full z-50 mt-1.5 w-[max(100%,20rem)] max-h-[min(70vh,22rem)] overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-card shadow-md"
              role="listbox"
              aria-label="Project search results"
            >
              <p className="border-b border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground">All your teams</span> — matches{' '}
                <span className="font-medium text-foreground">project names</span> only. Team names
                and descriptions are not included.
              </p>
              {allTeamsHeaderSearchLoading && headerSearchBasePool.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">Loading…</p>
              ) : headerSearchResults.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                  {headerProjectQuery.trim()
                    ? 'No projects match that name.'
                    : 'No projects in your teams yet.'}
                </p>
              ) : (
                <ul className="p-0.5">
                  {headerSearchResults.map((project) => (
                    <li key={project.id} role="option">
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          closeHeaderProjectSearch();
                          router.push(`/dashboard/projects/${project.id}`);
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                          project.id === currentProjectIdFromPath
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'hover:bg-accent',
                        )}
                      >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
                          {project.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1 text-left">
                          <p className="truncate font-medium" title={project.name}>
                            {project.name}
                          </p>
                          <p className="truncate text-xs text-muted-foreground" title={project.teamName}>
                            {project.teamName}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: team switcher + invites + user ────────────────── */}
      <div className="flex items-center gap-2 md:gap-3">
        {headerMobileSearchOpen && (
          <>
            <button
              type="button"
              className="fixed inset-0 z-[54] bg-background/60 backdrop-blur-[1px] md:hidden"
              aria-label="Dismiss search"
              onClick={closeHeaderProjectSearch}
            />
            <div
              className="fixed left-0 right-0 top-14 z-[55] flex max-h-[min(70vh,22rem)] flex-col border-b border-border bg-card shadow-lg md:hidden"
              data-header-project-search="true"
            >
              <div className="shrink-0 border-b border-border px-3 pb-2 pt-3">
                <p className="text-sm font-semibold text-foreground">Search projects</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  Type a <span className="font-medium text-foreground">project name</span>. We search
                  across <span className="font-medium text-foreground">all teams</span> you belong to
                  (team names are not searched).
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <input
                  ref={headerSearchInputMobileRef}
                  value={headerProjectQuery}
                  onChange={(e) => setHeaderProjectQuery(e.target.value)}
                  placeholder="e.g. billing, api, website…"
                  autoComplete="off"
                  autoCorrect="off"
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={closeHeaderProjectSearch}
                  aria-label="Close search"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {allTeamsHeaderSearchLoading && headerSearchBasePool.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-muted-foreground">Loading…</p>
                ) : headerSearchResults.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                    {headerProjectQuery.trim()
                      ? 'No projects match that name.'
                      : 'No projects in your teams yet.'}
                  </p>
                ) : (
                  <ul>
                    {headerSearchResults.map((project) => (
                      <li key={project.id}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            closeHeaderProjectSearch();
                            router.push(`/dashboard/projects/${project.id}`);
                          }}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors',
                            project.id === currentProjectIdFromPath
                              ? 'bg-primary/10 font-medium text-primary'
                              : 'active:bg-accent',
                          )}
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
                            {project.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1 text-left">
                            <p className="truncate font-medium" title={project.name}>
                              {project.name}
                            </p>
                            <p
                              className="truncate text-xs text-muted-foreground"
                              title={project.teamName}
                            >
                              {project.teamName}
                            </p>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}

        <button
          onClick={() => { closeHeaderProjectSearch(); setMobileMenuOpen(!mobileMenuOpen); }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background text-foreground md:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" />
        </button>
        {/* Team Switcher */}
        <div className="relative hidden md:block" data-nav-dropdown-root="true">
          <button
            onClick={() => {
              closeHeaderProjectSearch();
              setProjectsMenuOpen(false);
              setDocsMenuOpen(false);
              setUserMenuOpen(false);
              setDropdownOpen(!dropdownOpen);
              if (dropdownOpen) {
                setTeamSearch('');
              }
            }}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/80 dark:hover:bg-muted/50"
          >
            <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="hidden max-w-[140px] truncate xl:inline">
              {activeTeam?.name || 'Select team'}
            </span>
            {activeTeam?.role === 'OWNER' && (
              <span className="hidden xl:inline text-[10px] font-semibold text-amber-600 dark:text-amber-400 shrink-0 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded-full border border-amber-200 dark:border-amber-800">
                Owner
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>

          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border bg-card shadow-lg animate-fade-in">
                <div className="border-b p-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={teamSearch}
                      onChange={(e) => setTeamSearch(e.target.value)}
                      placeholder="Search teams..."
                      className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div className="p-1">
                  {filteredTeams.length === 0 ? (
                    <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                      No teams found.
                    </div>
                  ) : filteredTeams.map((team) => (
                    <button
                      key={team.id}
                      onClick={() => switchTeam(team.id)}
                      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                        team.id === activeTeamId
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'hover:bg-accent'
                      }`}
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-gradient text-white text-xs font-bold shadow-sm shrink-0">
                        {team.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 text-left flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate font-medium">{team.name}</p>
                          {team.role === 'OWNER' && (
                            <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 shrink-0 bg-amber-50 dark:bg-amber-950/40 px-1 rounded">Owner</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {team.memberCount} member{team.memberCount !== 1 ? 's' : ''} · {team.projectCount} project{team.projectCount !== 1 ? 's' : ''}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="border-t p-1 space-y-0.5">
                  <button
                    onClick={() => { setDropdownOpen(false); router.push('/dashboard/team'); }}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    Team Settings
                  </button>
                  {newTeamOpen ? (
                    <div className="px-2 pb-1 pt-0.5 space-y-1.5">
                      <input
                        autoFocus
                        type="text"
                        placeholder="Team name..."
                        value={newTeamName}
                        onChange={(e) => setNewTeamName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleCreateTeam();
                          if (e.key === 'Escape') { setNewTeamOpen(false); setNewTeamName(''); }
                        }}
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <div className="flex gap-1.5">
                        <button
                          onClick={handleCreateTeam}
                          disabled={creatingTeam || !newTeamName.trim()}
                          className="flex-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                        >
                          {creatingTeam ? 'Creating...' : 'Create'}
                        </button>
                        <button
                          onClick={() => { setNewTeamOpen(false); setNewTeamName(''); }}
                          className="rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewTeamOpen(true)}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors text-muted-foreground"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New Team
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Projects (active team) */}
        <div className="relative hidden md:block" data-nav-dropdown-root="true">
          <button
            type="button"
            onClick={() => {
              closeHeaderProjectSearch();
              setDropdownOpen(false);
              setDocsMenuOpen(false);
              setUserMenuOpen(false);
              setProjectsMenuOpen(!projectsMenuOpen);
              if (projectsMenuOpen) {
                setProjectSearch('');
              }
            }}
            disabled={!activeTeamId && !routeProject}
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/80 dark:hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="hidden max-w-[160px] truncate xl:inline" title={projectsMenuLabel}>
              {projectsMenuLabel}
            </span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </button>

          {projectsMenuOpen && (activeTeamId || routeProject) && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setProjectsMenuOpen(false)}
              />
              <div className="absolute right-0 top-full z-50 mt-1 w-72 max-h-[min(24rem,calc(100vh-5rem))] overflow-hidden rounded-lg border bg-card shadow-lg animate-fade-in flex flex-col">
                <div className="border-b px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Projects in {activeTeam?.name ?? 'team'}
                  </p>
                  <div className="relative mt-2">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={projectSearch}
                      onChange={(e) => setProjectSearch(e.target.value)}
                      placeholder="Search projects..."
                      className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">
                  {projectsLoading && filteredProjects.length === 0 ? (
                    <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                      Loading…
                    </div>
                  ) : filteredProjects.length === 0 ? (
                    <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                      No projects found.
                    </div>
                  ) : (
                    filteredProjects.map((project) => (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => {
                          setProjectsMenuOpen(false);
                          router.push(`/dashboard/projects/${project.id}`);
                        }}
                        className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors ${
                          project.id === currentProjectIdFromPath
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'hover:bg-accent'
                        }`}
                      >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-xs font-bold text-primary">
                          {project.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium" title={project.name}>
                            {project.name}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {project.slug}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
                <div className="border-t p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setProjectsMenuOpen(false);
                      router.push('/dashboard/projects');
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <List className="h-3.5 w-3.5" />
                    All projects
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        {inviteCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="relative hidden h-9 md:inline-flex"
            onClick={() => router.push('/dashboard/team')}
          >
            <Bell className="mr-1.5 h-3.5 w-3.5" />
            {inviteCount} invite{inviteCount > 1 ? 's' : ''}
          </Button>
        )}

        <div className="hidden md:block">
          <ThemeToggle />
        </div>
        <div className="hidden md:block">
          <NotificationsBell />
        </div>

        <UserMenu
          user={user}
          profile={profile ?? null}
          open={userMenuOpen}
          onOpenChange={(next) => {
            setUserMenuOpen(next);
            if (next) {
              closeHeaderProjectSearch();
              setDropdownOpen(false);
              setProjectsMenuOpen(false);
              setDocsMenuOpen(false);
            }
          }}
          onLogout={handleLogout}
        />
      </div>

      <FeedbackModal open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      {mobileMenuOpen && (
        <>
          <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMobileMenuOpen(false)} />
          <div className="absolute right-3 top-14 z-50 w-64 rounded-lg border bg-card p-2 shadow-lg md:hidden">
            <button
              onClick={() => { setMobileMenuOpen(false); router.push('/dashboard'); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>
            <button
              onClick={() => { setMobileMenuOpen(false); router.push('/dashboard/projects'); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <FolderOpen className="h-4 w-4" />
              Projects
            </button>
            <button
              onClick={() => { setMobileMenuOpen(false); router.push('/dashboard/team'); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <Users className="h-4 w-4" />
              Team
            </button>
            <button
              onClick={() => { setMobileMenuOpen(false); router.push('/dashboard/account'); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <Settings className="h-4 w-4" />
              Account
            </button>
            <button
              onClick={() => { setMobileMenuOpen(false); setFeedbackOpen(true); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent"
            >
              <MessageSquarePlus className="h-4 w-4" />
              Feedback
            </button>
            <div className="my-1 border-t" />
            <div className="px-3 py-1 text-xs text-muted-foreground">
              Team: {activeTeam?.name || 'Not selected'}
            </div>
            <div className="px-3 py-1 text-xs text-muted-foreground truncate">
              User:{' '}
              {user.email?.trim() || user.preferred_username?.trim() || user.sub || '—'}
            </div>
            <button
              onClick={() => { setMobileMenuOpen(false); handleLogout(); }}
              className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </>
      )}
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

function DocsMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <div className="relative" data-nav-dropdown-root="true">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => onOpenChange(!open)}
      >
        <Book className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Docs</span>
        <ChevronDown className="h-3 w-3" />
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => onOpenChange(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border bg-card shadow-lg animate-fade-in">
            <div className="p-1">
              {docsLinks.map((item) => (
                <a
                  key={item.href}
                  href={`${docsBaseUrl}${item.href}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => onOpenChange(false)}
                  className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
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

function UserMenu({
  user,
  profile,
  open,
  onOpenChange,
  onLogout,
}: {
  user: UserInfo;
  profile: UserProfile | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogout: () => void;
}) {
  const router = useRouter();

  const loginLabel =
    user.email?.trim() ||
    user.preferred_username?.trim() ||
    user.sub?.trim() ||
    'User';
  const firstName = profile?.firstName ?? '';
  const lastName = profile?.lastName ?? '';
  const displayName = [firstName, lastName].filter(Boolean).join(' ') || loginLabel;
  const initialsSource = firstName || loginLabel || user.sub || 'U';
  const initials = firstName && lastName
    ? `${firstName[0]}${lastName[0]}`.toUpperCase()
    : initialsSource.slice(0, 2).toUpperCase();
  const avatarUrl = profile?.avatarUrl;

  return (
    <div className="relative" data-nav-dropdown-root="true">
      <button
        onClick={() => onOpenChange(!open)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent"
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
          <div className="fixed inset-0 z-40" onClick={() => onOpenChange(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border bg-card shadow-lg animate-fade-in">
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
                onClick={() => { onOpenChange(false); router.push('/dashboard/account'); }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
              >
                <KeyRound className="h-3.5 w-3.5" />
                Account Settings
              </button>
            </div>
            <div className="border-t p-1">
              <button
                onClick={() => { onOpenChange(false); onLogout(); }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors"
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
