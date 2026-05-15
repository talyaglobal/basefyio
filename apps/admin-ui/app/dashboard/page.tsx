'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { api } from '@/lib/api';
import type { ProjectListItem, TeamMember } from '@/lib/types';
import { useActiveTeam, useDashboard } from './layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Database,
  FolderOpen,
  Plus,
  Search,
  TrendingUp,
  Users,
  Activity,
  Calendar,
  CheckCircle2,
  PauseCircle,
  X,
} from 'lucide-react';
import { format, subMonths, startOfMonth, endOfMonth, parseISO, isWithinInterval } from 'date-fns';
import { RootAlertsPanel } from '@/components/root-alerts-panel';
import { cn } from '@/lib/utils';

// ── Helpers ──────────────────────────────────────────────────
function buildMonthlyData(projects: ProjectListItem[], months = 6) {
  return Array.from({ length: months }, (_, i) => {
    const d = subMonths(new Date(), months - 1 - i);
    const start = startOfMonth(d);
    const end = endOfMonth(d);
    const count = projects.filter((p) => {
      const created = parseISO(p.createdAt);
      return isWithinInterval(created, { start, end });
    }).length;
    return { month: format(d, 'MMM'), count };
  });
}

function buildStatusData(projects: ProjectListItem[]) {
  const active = projects.filter((p) => p.status === 'ACTIVE').length;
  const paused = projects.filter((p) => p.status === 'PAUSED').length;
  const deleted = projects.filter((p) => p.status === 'DELETED').length;
  return [
    { name: 'Active', value: active, color: '#22c55e' },
    { name: 'Paused', value: paused, color: '#f59e0b' },
    { name: 'Deleted', value: deleted, color: '#ef4444' },
  ].filter((d) => d.value > 0);
}

// ── Stat Card ─────────────────────────────────────────────────
function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl border bg-card p-5 shadow-sm transition-all ${
        onClick ? 'hover:shadow-md hover:border-primary/30 hover:-translate-y-0.5 cursor-pointer active:scale-[0.98]' : ''
      }`}
    >
      {/* Icon + Label row */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${accent ?? 'bg-primary/10'}`}>
          <Icon className={`h-4 w-4 ${accent ? 'text-white' : 'text-primary'}`} />
        </div>
        <span className="text-sm font-medium text-muted-foreground leading-tight">{label}</span>
        {onClick && (
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40 ml-auto shrink-0 group-hover:text-primary transition-colors" />
        )}
      </div>
      {/* Value */}
      <p className="text-3xl font-bold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </button>
  );
}

// ── Main ─────────────────────────────────────────────────────
export default function DashboardPage() {
  const router = useRouter();
  const { activeTeamId, setActiveTeamId } = useActiveTeam();
  const { profile, teams } = useDashboard();

  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [teamDropdownOpen, setTeamDropdownOpen] = useState(false);

  const activeTeam = teams.find((t) => t.id === activeTeamId);
  const sortedTeams = useMemo(() => [...teams].sort((a, b) => a.name.localeCompare(b.name)), [teams]);

  // Close team dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-team-selector="true"]')) return;
      setTeamDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  async function switchTeam(teamId: string) {
    try {
      await api.teams.setActive(teamId);
      const Cookies = (await import('js-cookie')).default;
      Cookies.set('kb_active_team', teamId, { expires: 365, path: '/' });
      setActiveTeamId(teamId);
      setTeamDropdownOpen(false);
    } catch { /* silent */ }
  }

  // ── Project search (all teams) ──
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [allTeamsProjects, setAllTeamsProjects] = useState<(ProjectListItem & { teamId: string; teamName: string })[]>([]);
  const [allTeamsLoading, setAllTeamsLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!activeTeamId) return;
    setLoading(true);
    Promise.all([
      api.projects.list(activeTeamId),
      api.teams.listMembers(activeTeamId),
    ])
      .then(([p, m]) => {
        setProjects(p);
        setMembers(m);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [activeTeamId]);

  // Load all team projects for search
  useEffect(() => {
    if (!teams.length) { setAllTeamsProjects([]); return; }
    let cancelled = false;
    setAllTeamsLoading(true);
    void Promise.all(
      teams.map((team) =>
        api.projects.list(team.id)
          .then((list) => list.filter((p) => p.status === 'ACTIVE').map((p) => ({ ...p, teamId: team.id, teamName: team.name })))
          .catch(() => [] as (ProjectListItem & { teamId: string; teamName: string })[]),
      ),
    ).then((chunks) => {
      if (!cancelled) setAllTeamsProjects(chunks.flat());
    }).finally(() => { if (!cancelled) setAllTeamsLoading(false); });
    return () => { cancelled = true; };
  }, [teams]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const sorted = [...allTeamsProjects].sort((a, b) => {
      const au = a.updatedAt || a.createdAt || '';
      const bu = b.updatedAt || b.createdAt || '';
      return au < bu ? 1 : au > bu ? -1 : a.name.localeCompare(b.name);
    });
    if (!q) return sorted.slice(0, 12);
    return sorted.filter((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
  }, [allTeamsProjects, searchQuery]);

  const showSearchDropdown = searchFocused || searchQuery.trim().length > 0;

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-dashboard-search="true"]')) return;
      setSearchFocused(false);
      setSearchQuery('');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Derived stats
  const activeCount = projects.filter((p) => p.status === 'ACTIVE').length;
  const thisMonth = projects.filter((p) => {
    const start = startOfMonth(new Date());
    return isWithinInterval(parseISO(p.createdAt), { start, end: new Date() });
  }).length;
  const recentProjects = [...projects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);

  const monthlyData = buildMonthlyData(projects, 6);
  const totalThisMonth = monthlyData[monthlyData.length - 1].count;
  const totalLastMonth = monthlyData[monthlyData.length - 2].count;
  const trendUp = totalThisMonth >= totalLastMonth;

  const statusData = buildStatusData(projects);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="kb-grid-row-hover grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border bg-card" />
          ))}
        </div>
        <div className="kb-grid-row-hover grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 h-64 animate-pulse rounded-xl border bg-card" />
          <div className="h-64 animate-pulse rounded-xl border bg-card" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {profile?.role === 'ROOT' && <RootAlertsPanel showRead={false} title="ROOT Alerts (Unread)" />}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Your team&apos;s activity at a glance.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="bg-brand-gradient text-white border-0 hover:opacity-90">
          <Plus className="mr-2 h-4 w-4" />
          New Project
        </Button>
      </div>

      {/* Team selector + search */}
      <div className="flex items-center gap-3">
        {/* Team selector */}
        <div className="relative shrink-0" data-team-selector="true">
          <button
            type="button"
            onClick={() => setTeamDropdownOpen((prev) => !prev)}
            className="flex h-12 items-center gap-2 rounded-xl border border-input bg-card px-4 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
          >
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="max-w-[160px] truncate">{activeTeam?.name ?? 'Select team'}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {teamDropdownOpen && (
            <div className="absolute left-0 top-full z-40 mt-1.5 w-64 max-h-72 overflow-y-auto rounded-xl border bg-card p-1 shadow-lg">
              {sortedTeams.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-muted-foreground">No teams found.</p>
              ) : sortedTeams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => void switchTeam(t.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                    t.id === activeTeamId ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent',
                  )}
                >
                  <span className="truncate">{t.name}</span>
                  {t.id === activeTeamId && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Search */}
        <div className="relative min-w-0 flex-1" data-dashboard-search="true">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => { setTimeout(() => setSearchFocused(false), 150); }}
            placeholder="Search projects across all your teams..."
            autoComplete="off"
            autoCorrect="off"
            className={cn(
              'h-12 w-full rounded-xl border border-input bg-card pl-12 pr-12 text-sm shadow-sm',
              'placeholder:text-muted-foreground/70',
              'focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/30',
              'transition-shadow duration-150',
            )}
          />
          {searchQuery && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setSearchQuery('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        {showSearchDropdown && (
          <div className="absolute left-0 top-full z-30 mt-2 w-full max-h-[min(60vh,24rem)] overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
            {allTeamsLoading && allTeamsProjects.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Loading projects…</p>
            ) : searchResults.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {searchQuery.trim() ? 'No projects match that name.' : 'No projects in your teams yet.'}
              </p>
            ) : (
              <ul className="p-1">
                {searchResults.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setSearchQuery('');
                        setSearchFocused(false);
                        router.push(`/dashboard/projects/${project.id}`);
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-sm transition-colors hover:bg-accent"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-sm font-bold text-white shadow-sm">
                        {project.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{project.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{project.teamName}</p>
                      </div>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/40" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        </div>
      </div>

      {/* Stat Cards */}
      <div className="kb-grid-row-hover grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Database}
          label="Total Projects"
          value={projects.length}
          sub={`${activeCount} active`}
          accent="bg-primary"
          onClick={() => router.push('/dashboard/projects')}
        />
        <StatCard
          icon={CheckCircle2}
          label="Active Projects"
          value={activeCount}
          sub={projects.length > 0 ? `${Math.round((activeCount / projects.length) * 100)}% of total` : undefined}
          onClick={() => router.push('/dashboard/projects?status=ACTIVE')}
        />
        <StatCard
          icon={Users}
          label="Team Members"
          value={members.length}
          sub={`${members.filter((m) => m.role === 'OWNER').length} owner`}
          onClick={() => router.push('/dashboard/team')}
        />
        <StatCard
          icon={Calendar}
          label="Created This Month"
          value={thisMonth}
          sub={trendUp ? '↑ more than last month' : totalLastMonth > 0 ? '↓ less than last month' : 'No projects last month'}
          onClick={() => router.push('/dashboard/projects?filter=this-month')}
        />
      </div>

      {/* Charts Row */}
      <div className="kb-grid-row-hover grid gap-4 lg:grid-cols-3">
        {/* Monthly Area Chart */}
        <div className="lg:col-span-2 rounded-xl border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Project Creation</h2>
              <p className="text-xs text-muted-foreground">Last 6 months</p>
            </div>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={monthlyData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="month" tick={{ fontSize: 12 }} className="text-muted-foreground" />
              <YAxis tick={{ fontSize: 12 }} allowDecimals={false} className="text-muted-foreground" />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                labelStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}
                itemStyle={{ color: 'hsl(var(--primary))' }}
              />
              <Area
                type="monotone"
                dataKey="count"
                name="Projects"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#areaGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Status Bar Chart */}
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-semibold">By Status</h2>
              <p className="text-xs text-muted-foreground">Current distribution</p>
            </div>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </div>
          {statusData.length === 0 ? (
            <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
              No projects yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={statusData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8 }}
                  labelStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}
                />
                <Bar dataKey="value" name="Projects" radius={[4, 4, 0, 0]}>
                  {statusData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          {/* Legend */}
          <div className="mt-3 flex flex-wrap gap-3">
            {statusData.map((s) => (
              <div key={s.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.name} ({s.value})
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Projects + Quick Actions Row */}
      <div className="kb-grid-row-hover grid gap-4 lg:grid-cols-3">
        {/* Recent Projects */}
        <div className="lg:col-span-2 rounded-xl border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Recent Projects</h2>
              <p className="text-xs text-muted-foreground">Last updated</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => router.push('/dashboard/projects')}
            >
              View all
              <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </div>

          {recentProjects.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed">
              <FolderOpen className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">No projects yet</p>
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Create first project
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              {recentProjects.map((p) => (
                <button
                  key={p.id}
                  onClick={() => router.push(`/dashboard/projects/${p.id}`)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent group"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-gradient shadow-sm">
                    <Database className="h-4 w-4 text-white" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Updated {format(parseISO(p.updatedAt), 'MMM d, yyyy')}
                    </p>
                  </div>
                  <Badge
                    variant={p.status === 'ACTIVE' ? 'default' : 'secondary'}
                    className={`shrink-0 text-[10px] h-5 ${p.status === 'ACTIVE' ? 'bg-emerald-600' : p.status === 'PAUSED' ? 'bg-amber-500' : ''}`}
                  >
                    {p.status}
                  </Badge>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Quick Actions */}
        <div className="rounded-xl border bg-card p-5 space-y-4">
          <div>
            <h2 className="font-semibold">Quick Actions</h2>
            <p className="text-xs text-muted-foreground">Common tasks</p>
          </div>

          <div className="space-y-2">
            <button
              onClick={() => setDialogOpen(true)}
              className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-accent"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-gradient text-white shadow-sm">
                <Plus className="h-4 w-4" />
              </div>
              New Project
            </button>

            <button
              onClick={() => router.push('/dashboard/projects')}
              className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-accent"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
              </div>
              All Projects
              <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </button>

            <button
              onClick={() => router.push('/dashboard/team')}
              className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-accent"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
              Team Settings
              <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </button>

            <button
              onClick={() => router.push('/dashboard/account')}
              className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-accent"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
                <Activity className="h-4 w-4 text-muted-foreground" />
              </div>
              Account Settings
              <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      </div>

      {activeTeamId && (
        <CreateProjectDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={() => {
            setDialogOpen(false);
            api.projects.list(activeTeamId).then(setProjects).catch(() => {});
          }}
          teamId={activeTeamId}
        />
      )}
    </div>
  );
}
