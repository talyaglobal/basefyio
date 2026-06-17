'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useActiveTeam } from '@/app/dashboard/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import {
  Github,
  ExternalLink,
  Loader2,
  CheckCircle2,
  Unplug,
  GitCommit,
  GitBranch,
  Triangle,
  Circle,
  RefreshCw,
  ArrowLeft,
  Link2,
  Settings,
  Upload,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  GitHubIntegration,
  GitHubCommit,
  GitHubRepo,
  GitHubBranch,
  TeamGitHubStatus,
  TeamVercelStatus,
  VercelIntegration,
  VercelDeployment,
  VercelProject as VercelProjectType,
} from '@/lib/types';

function VercelLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 76 65" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}

function deployStateColor(state: string) {
  switch (state) {
    case 'READY': return 'text-emerald-500';
    case 'ERROR': return 'text-red-500';
    case 'BUILDING': return 'text-amber-500';
    case 'QUEUED': return 'text-blue-500';
    case 'CANCELED': return 'text-gray-400';
    default: return 'text-muted-foreground';
  }
}

function deployStateBadge(state: string) {
  switch (state) {
    case 'READY': return 'default';
    case 'ERROR': return 'destructive';
    default: return 'secondary';
  }
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── GitHub Card ──────────────────────────────────

function GitHubCard({
  projectId,
  teamId,
  teamGitHub,
}: {
  projectId: string;
  teamId: string;
  teamGitHub: TeamGitHubStatus | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<GitHubIntegration | null>(null);
  const [commits, setCommits] = useState<GitHubCommit[]>([]);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [changing, setChanging] = useState(false);

  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [repoBranches, setRepoBranches] = useState<GitHubBranch[]>([]);
  const [fetchingRepos, setFetchingRepos] = useState(false);
  const [fetchingBranches, setFetchingBranches] = useState(false);

  const useTeamToken = !!(teamGitHub?.connected);

  useEffect(() => {
    loadStatus();
  }, [projectId]);

  useEffect(() => {
    if (!changing && status?.connected) return;
    if (!useTeamToken) return;
    if (repos.length > 0) return;
    loadTeamRepos({ silent: true });
  }, [changing, useTeamToken]);

  useEffect(() => {
    if (!selectedRepo) {
      setRepoBranches([]);
      setSelectedBranch('');
      return;
    }
    if (!useTeamToken) return;
    const repo = repos.find((r) => r.full_name === selectedRepo);
    if (!repo) return;

    let cancelled = false;
    setFetchingBranches(true);
    api.teamIntegrations
      .listGitHubBranches(teamId, repo.owner, repo.name)
      .then((b) => {
        if (cancelled) return;
        setRepoBranches(b);
        setSelectedBranch(repo.default_branch || 'main');
      })
      .catch(() => {
        if (cancelled) return;
        setRepoBranches([]);
        setSelectedBranch(repo.default_branch || 'main');
      })
      .finally(() => {
        if (!cancelled) setFetchingBranches(false);
      });
    return () => { cancelled = true; };
  }, [selectedRepo]);

  async function loadStatus() {
    setLoading(true);
    try {
      const s = await api.integrations.getGitHub(projectId);
      setStatus(s);
      if (s.connected) {
        const [c, b] = await Promise.all([
          api.integrations.getGitHubCommits(projectId),
          api.integrations.getGitHubBranches(projectId),
        ]);
        setCommits(c);
        setBranches(b);
      }
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function loadTeamRepos(opts?: { silent?: boolean }) {
    if (!teamGitHub?.connected) return;
    setFetchingRepos(true);
    try {
      const r = await api.teamIntegrations.listGitHubRepos(teamId);
      setRepos(r);
    } catch (err: any) {
      // Auto-load (page mount) must not spam a toast — e.g. an expired team
      // GitHub token. Surface it only on an explicit user action.
      if (opts?.silent) {
        console.warn('GitHub repos load failed:', err?.message);
      } else {
        toast.error(err.message || 'Failed to load repositories');
      }
    } finally {
      setFetchingRepos(false);
    }
  }

  async function handleConnect() {
    if (!selectedRepo) return;
    const repo = repos.find((r) => r.full_name === selectedRepo);
    if (!repo) return;
    setConnecting(true);
    try {
      await api.integrations.connectGitHub(projectId, {
        token: '',
        owner: repo.owner,
        repo: repo.name,
        branch: selectedBranch || repo.default_branch,
        useTeamToken: true,
        teamId,
      });
      toast.success(`Connected to ${repo.full_name}`);
      setRepos([]);
      setSelectedRepo('');
      setChanging(false);
      await loadStatus();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setConnecting(false);
    }
  }

  function handleStartChange() {
    setChanging(true);
    setRepos([]);
    setSelectedRepo('');
    setSelectedBranch('');
    setRepoBranches([]);
    if (useTeamToken) loadTeamRepos();
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await api.integrations.disconnectGitHub(projectId);
      setStatus({ connected: false });
      setCommits([]);
      setBranches([]);
      toast.success('GitHub disconnected');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-center gap-3">
          <Github className="h-5 w-5" />
          <span className="font-semibold">GitHub</span>
        </div>
        <div className="mt-4 flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between p-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-900 dark:bg-zinc-100">
            <Github className="h-5 w-5 text-white dark:text-black" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">GitHub</h3>
              {useTeamToken && (
                <Badge variant="outline" className="text-[10px] h-4 border-emerald-500 text-emerald-600 dark:text-emerald-400">
                  <Link2 className="h-2.5 w-2.5 mr-1" />
                  Team
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {status?.connected ? `${status.owner}/${status.repo}` : 'Not connected'}
            </p>
          </div>
        </div>
        {status?.connected && !changing && (
          <div className="flex items-center gap-2">
            <a
              href={status.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              View
            </a>
            {useTeamToken && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStartChange}
                className="h-8"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                Change
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 h-8"
            >
              <Unplug className="h-3.5 w-3.5 mr-1" />
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
        )}
        {changing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChanging(false)}
            className="h-8"
          >
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Cancel
          </Button>
        )}
      </div>

      <Separator />

      {status?.connected && !changing ? (
        <div className="p-6 pt-4 space-y-4">
          <div className="flex items-center gap-4 text-sm">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <GitBranch className="h-3.5 w-3.5" />
              <span>{status.branch}</span>
            </div>
            {branches.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {branches.length} branches
              </span>
            )}
          </div>

          {commits.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Recent Commits
              </p>
              <div className="space-y-1">
                {commits.slice(0, 5).map((c) => (
                  <a
                    key={c.sha}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-3 rounded-lg p-2 -mx-2 hover:bg-muted/50 transition-colors"
                  >
                    {c.authorAvatar ? (
                      <img
                        src={c.authorAvatar}
                        alt={c.author}
                        className="h-6 w-6 rounded-full mt-0.5 shrink-0"
                      />
                    ) : (
                      <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center mt-0.5 shrink-0">
                        <GitCommit className="h-3 w-3 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate">{c.message}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                        <span>{c.author}</span>
                        <span>&middot;</span>
                        <span>{timeAgo(c.date)}</span>
                        <span className="font-mono text-[10px]">{c.sha.slice(0, 7)}</span>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="p-6 pt-4 space-y-4">
          {useTeamToken ? (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20 px-3 py-2 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Using team GitHub connection (<strong>{teamGitHub?.login}</strong>)
              </div>

              {fetchingRepos && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading repositories...
                </div>
              )}

              {repos.length > 0 && (
                <>
                  <div className="space-y-2">
                    <Label>Repository</Label>
                    <Combobox
                      options={repos.map((r): ComboboxOption => ({
                        value: r.full_name,
                        label: r.full_name,
                        description: r.private ? 'Private' : 'Public',
                      }))}
                      value={selectedRepo}
                      onValueChange={setSelectedRepo}
                      placeholder="Select a repository"
                      searchPlaceholder="Search repositories..."
                      emptyText="No repositories found."
                    />
                  </div>

                  {selectedRepo && (
                    <>
                      <div className="space-y-2">
                        <Label>Branch</Label>
                        {fetchingBranches ? (
                          <div className="flex h-10 items-center gap-2 rounded-md border border-input px-3 text-sm text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading branches...
                          </div>
                        ) : repoBranches.length > 0 ? (
                          <Combobox
                            options={repoBranches.map((b): ComboboxOption => ({
                              value: b.name,
                              label: b.name,
                              description: b.protected ? 'Protected' : undefined,
                            }))}
                            value={selectedBranch}
                            onValueChange={setSelectedBranch}
                            placeholder="Select a branch"
                            searchPlaceholder="Search branches..."
                            emptyText="No branches found."
                          />
                        ) : (
                          <Input
                            value={selectedBranch}
                            onChange={(e) => setSelectedBranch(e.target.value)}
                            placeholder="main"
                          />
                        )}
                      </div>

                      <Button
                        onClick={handleConnect}
                        disabled={!selectedRepo || connecting || fetchingBranches}
                        className="w-full"
                      >
                        {connecting ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{changing ? 'Switching...' : 'Connecting...'}</>
                        ) : (
                          <><Github className="h-4 w-4 mr-2" />{changing ? 'Switch Repository' : 'Connect Repository'}</>
                        )}
                      </Button>
                    </>
                  )}
                </>
              )}

              {changing && (
                <p className="text-xs text-muted-foreground text-center">
                  Currently connected to <span className="font-medium">{status?.owner}/{status?.repo}</span>. Select a new repository to switch.
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="rounded-full bg-muted p-3">
                <Github className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">GitHub not connected</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Connect GitHub at the team level to link repositories to this project.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/dashboard/team')}
              >
                <Settings className="h-3.5 w-3.5 mr-1.5" />
                Go to Team Settings
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Vercel Card ──────────────────────────────────

function VercelCard({
  projectId,
  teamId,
  teamVercel,
}: {
  projectId: string;
  teamId: string;
  teamVercel: TeamVercelStatus | null;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<VercelIntegration | null>(null);
  const [deployments, setDeployments] = useState<VercelDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [changing, setChanging] = useState(false);

  const [projects, setProjects] = useState<VercelProjectType[]>([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [fetchingProjects, setFetchingProjects] = useState(false);

  const [showEnvModal, setShowEnvModal] = useState(false);
  const [syncingEnv, setSyncingEnv] = useState(false);

  const useTeamToken = !!(teamVercel?.connected);

  useEffect(() => {
    loadStatus();
  }, [projectId]);

  useEffect(() => {
    if (!changing && status?.connected) return;
    if (!useTeamToken) return;
    if (projects.length > 0) return;
    loadTeamProjects({ silent: true });
  }, [changing, useTeamToken]);

  async function loadStatus() {
    setLoading(true);
    try {
      const s = await api.integrations.getVercel(projectId);
      setStatus(s);
      if (s.connected) {
        const d = await api.integrations.getVercelDeployments(projectId);
        setDeployments(d);
      }
    } catch {
      setStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function loadTeamProjects(opts?: { silent?: boolean }) {
    if (!teamVercel?.connected) return;
    setFetchingProjects(true);
    try {
      const p = await api.teamIntegrations.listVercelProjects(teamId);
      setProjects(p);
    } catch (err: any) {
      // Auto-load (page mount) must not spam a toast — e.g. an expired team
      // Vercel token. Surface it only on an explicit user action.
      if (opts?.silent) {
        console.warn('Vercel projects load failed:', err?.message);
      } else {
        toast.error(err.message || 'Failed to load Vercel projects');
      }
    } finally {
      setFetchingProjects(false);
    }
  }

  async function handleConnect() {
    if (!selectedProject) return;
    setConnecting(true);
    try {
      await api.integrations.connectVercel(projectId, {
        token: '',
        projectId: selectedProject,
        useTeamToken: true,
        sourceTeamId: teamId,
      });
      const proj = projects.find((p) => p.id === selectedProject);
      toast.success(`Connected to ${proj?.name || selectedProject}`);
      setProjects([]);
      setSelectedProject('');
      setChanging(false);
      await loadStatus();
      setShowEnvModal(true);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleSyncEnv() {
    setSyncingEnv(true);
    try {
      const result = await api.integrations.syncVercelEnv(projectId);
      toast.success(
        `Environment variables synced: ${result.created} created, ${result.updated} updated`,
      );
      setShowEnvModal(false);
    } catch (err: any) {
      toast.error(err.message || 'Failed to sync environment variables');
    } finally {
      setSyncingEnv(false);
    }
  }

  function handleStartChange() {
    setChanging(true);
    setProjects([]);
    setSelectedProject('');
    if (useTeamToken) loadTeamProjects();
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await api.integrations.disconnectVercel(projectId);
      setStatus({ connected: false });
      setDeployments([]);
      toast.success('Vercel disconnected');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-center gap-3">
          <Triangle className="h-5 w-5" />
          <span className="font-semibold">Vercel</span>
        </div>
        <div className="mt-4 flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between p-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-black dark:bg-white">
            <VercelLogo className="h-4 w-4 text-white dark:text-black" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">Vercel</h3>
              {useTeamToken && (
                <Badge variant="outline" className="text-[10px] h-4 border-emerald-500 text-emerald-600 dark:text-emerald-400">
                  <Link2 className="h-2.5 w-2.5 mr-1" />
                  Team
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {status?.connected ? (status.projectName || status.projectId) : 'Not connected'}
            </p>
          </div>
        </div>
        {status?.connected && !changing && (
          <div className="flex items-center gap-2">
            {status.projectUrl && (
              <a
                href={status.projectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="h-3 w-3" />
                View
              </a>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowEnvModal(true)}
              className="h-8"
            >
              <Upload className="h-3.5 w-3.5 mr-1" />
              Sync Env
            </Button>
            {useTeamToken && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleStartChange}
                className="h-8"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                Change
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 h-8"
            >
              <Unplug className="h-3.5 w-3.5 mr-1" />
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </Button>
          </div>
        )}
        {changing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChanging(false)}
            className="h-8"
          >
            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
            Cancel
          </Button>
        )}
      </div>

      <Separator />

      {status?.connected && !changing ? (
        <div className="p-6 pt-4 space-y-4">
          {deployments.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Recent Deployments
              </p>
              <div className="space-y-1">
                {deployments.slice(0, 5).map((d) => (
                  <a
                    key={d.id}
                    href={d.url || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`flex items-start gap-3 rounded-lg p-2 -mx-2 transition-colors ${d.url ? 'hover:bg-muted/50 cursor-pointer' : 'cursor-default'}`}
                  >
                    <Circle className={`h-3 w-3 mt-1.5 shrink-0 fill-current ${deployStateColor(d.state)}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm truncate">
                          {d.commitMessage || 'No commit message'}
                        </p>
                        <Badge variant={deployStateBadge(d.state) as any} className="text-[10px] h-4 shrink-0">
                          {d.state}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                        {d.branch && <span>{d.branch}</span>}
                        {d.branch && <span>&middot;</span>}
                        <span>{timeAgo(d.createdAt)}</span>
                        {d.url && (
                          <>
                            <span>&middot;</span>
                            <span className="hover:underline">
                              {new URL(d.url).hostname}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No deployments found</p>
          )}
        </div>
      ) : (
        <div className="p-6 pt-4 space-y-4">
          {useTeamToken ? (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20 px-3 py-2 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Using team Vercel connection (<strong>{teamVercel?.user}</strong>)
              </div>

              {fetchingProjects && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading projects...
                </div>
              )}

              {projects.length > 0 && (
                <>
                  <div className="space-y-2">
                    <Label>Project</Label>
                    <Combobox
                      options={projects.map((p): ComboboxOption => ({
                        value: p.id,
                        label: p.name,
                        description: p.framework || undefined,
                      }))}
                      value={selectedProject}
                      onValueChange={setSelectedProject}
                      placeholder="Select a project"
                      searchPlaceholder="Search projects..."
                      emptyText="No projects found."
                    />
                  </div>

                  <Button
                    onClick={handleConnect}
                    disabled={!selectedProject || connecting}
                    className="w-full bg-black hover:bg-zinc-800 text-white"
                  >
                    {connecting ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" />{changing ? 'Switching...' : 'Connecting...'}</>
                    ) : (
                      <><VercelLogo className="h-3.5 w-3.5 mr-2" />{changing ? 'Switch Project' : 'Connect Project'}</>
                    )}
                  </Button>
                </>
              )}

              {changing && (
                <p className="text-xs text-muted-foreground text-center">
                  Currently connected to <span className="font-medium">{status?.projectName || status?.projectId}</span>. Select a new project to switch.
                </p>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <div className="rounded-full bg-muted p-3">
                <VercelLogo className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Vercel not connected</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Connect Vercel at the team level to link projects to deployments.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push('/dashboard/team')}
              >
                <Settings className="h-3.5 w-3.5 mr-1.5" />
                Go to Team Settings
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={showEnvModal} onOpenChange={setShowEnvModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save Environment Variables</DialogTitle>
            <DialogDescription>
              Would you like to sync your basefyio project&apos;s environment variables
              to the connected Vercel project? This will create or update the following
              variables for all environments (production, preview, development):
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm font-mono space-y-1">
            <p>NEXT_PUBLIC_BASEFYIO_URL</p>
            <p>NEXT_PUBLIC_BASEFYIO_ANON_KEY</p>
            <p className="text-amber-600 dark:text-amber-400">BASEFYIO_SERVICE_ROLE_KEY</p>
            <p>DATABASE_URL</p>
            <p>DIRECT_URL</p>
            <p>PROJECT_ID</p>
          </div>
          <p className="text-xs text-muted-foreground">
            Sensitive values (service key, database credentials) are stored as encrypted environment variables on Vercel.
          </p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              onClick={() => setShowEnvModal(false)}
              disabled={syncingEnv}
            >
              Skip
            </Button>
            <Button onClick={handleSyncEnv} disabled={syncingEnv}>
              {syncingEnv ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Syncing...</>
              ) : (
                <><Upload className="h-4 w-4 mr-2" />Sync Variables</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────

export default function IntegrationsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { activeTeamId } = useActiveTeam();
  const [teamGitHub, setTeamGitHub] = useState<TeamGitHubStatus | null>(null);
  const [teamVercel, setTeamVercel] = useState<TeamVercelStatus | null>(null);
  const [loadingTeam, setLoadingTeam] = useState(true);

  useEffect(() => {
    if (!activeTeamId) return;
    setLoadingTeam(true);
    Promise.all([
      api.teamIntegrations.getGitHubStatus(activeTeamId),
      api.teamIntegrations.getVercelStatus(activeTeamId),
    ])
      .then(([gh, vc]) => {
        setTeamGitHub(gh);
        setTeamVercel(vc);
      })
      .catch(() => {
        setTeamGitHub({ connected: false, oauthConfigured: false });
        setTeamVercel({ connected: false, oauthConfigured: false });
      })
      .finally(() => setLoadingTeam(false));
  }, [activeTeamId]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Integrations</h1>
        <p className="mt-1 text-muted-foreground">
          Connect your project to external services.
        </p>
      </div>

      {/* Team integration status banner */}
      {!loadingTeam && activeTeamId && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm font-medium text-muted-foreground">Team connections:</span>
            <div className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${teamGitHub?.connected ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30' : 'border-muted-foreground/30 text-muted-foreground'}`}>
                <Github className="h-3 w-3" />
                {teamGitHub?.connected ? teamGitHub.login : 'GitHub not connected'}
              </div>
              <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${teamVercel?.connected ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30' : 'border-muted-foreground/30 text-muted-foreground'}`}>
                <VercelLogo className="h-3 w-3" />
                {teamVercel?.connected ? teamVercel.user : 'Vercel not connected'}
              </div>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs shrink-0"
            onClick={() => router.push('/dashboard/team')}
          >
            <Settings className="h-3 w-3 mr-1" />
            Manage
          </Button>
        </div>
      )}

      {loadingTeam ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="basefyio-grid-row-hover grid gap-6 lg:grid-cols-2">
          <GitHubCard
            projectId={id}
            teamId={activeTeamId || ''}
            teamGitHub={teamGitHub}
          />
          <VercelCard
            projectId={id}
            teamId={activeTeamId || ''}
            teamVercel={teamVercel}
          />
        </div>
      )}
    </div>
  );
}
