'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  parseProjectSupabaseImportLog,
  type Project,
  type GitHubCommit,
  type VercelDeployment,
  type GitHubIntegration,
  type VercelIntegration,
  type Team,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Database, Github, Key, Shield, Trash2, Triangle,
  GitBranch, GitCommit, Circle, ExternalLink, ArrowRightLeft,
  HardDrive, ScrollText, AlertTriangle,
} from 'lucide-react';

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

function deployStateColor(state: string) {
  switch (state) {
    case 'READY': return 'text-emerald-500';
    case 'ERROR': return 'text-red-500';
    case 'BUILDING': return 'text-amber-500';
    case 'QUEUED': return 'text-blue-500';
    default: return 'text-muted-foreground';
  }
}

interface ProjectDetailProps {
  project: Project;
}

export function ProjectDetail({ project }: ProjectDetailProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [commits, setCommits] = useState<GitHubCommit[]>([]);
  const [deployments, setDeployments] = useState<VercelDeployment[]>([]);
  const [githubStatus, setGithubStatus] = useState<GitHubIntegration | null>(null);
  const [vercelStatus, setVercelStatus] = useState<VercelIntegration | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [moveTeamOpen, setMoveTeamOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [movingTeam, setMovingTeam] = useState(false);

  useEffect(() => {
    api.teams.list().then(setTeams).catch(() => {});
  }, []);

  useEffect(() => {
    if (project.github?.connected) {
      api.integrations.getGitHub(project.id)
        .then((s) => setGithubStatus(s))
        .catch(() => {});
      api.integrations.getGitHubCommits(project.id)
        .then((c) => setCommits(c.slice(0, 3)))
        .catch(() => {});
    }
    if (project.vercel?.connected) {
      api.integrations.getVercel(project.id)
        .then((s) => setVercelStatus(s))
        .catch(() => {});
      api.integrations.getVercelDeployments(project.id)
        .then((d) => setDeployments(d.slice(0, 3)))
        .catch(() => {});
    }
  }, [project.id, project.github?.connected, project.vercel?.connected]);

  async function handleDelete() {
    if (!confirm(`Move "${project.name}" to trash?\n\nThe project will stay in trash for 24 hours. The team owner can restore it during this period. After 24 hours it will be permanently deleted.`)) return;

    setDeleting(true);
    try {
      await api.projects.delete(project.id);
      toast.success('Project moved to trash');
      router.push('/dashboard/projects');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleMoveToTeam() {
    if (!selectedTeam) return;
    setMovingTeam(true);
    try {
      await api.projects.moveToTeam(project.id, selectedTeam.id);
      toast.success(`"${project.name}" moved to "${selectedTeam.name}"`);
      router.push('/dashboard/projects');
    } catch (err: any) {
      toast.error(err.message || 'Failed to move project');
    } finally {
      setMovingTeam(false);
    }
  }

  const otherTeams = teams.filter((t) => t.id !== project.teamId);

  const gh = githubStatus?.connected ? githubStatus : project.github;
  const vc = vercelStatus?.connected ? vercelStatus : project.vercel;
  const vercelDashboardUrl = vercelStatus?.dashboardUrl || null;
  const importLog = parseProjectSupabaseImportLog(project.supabaseImportLog);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
          {project.description && (
            <p className="mt-1 text-muted-foreground">{project.description}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Created {new Date(project.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={project.status === 'ACTIVE' ? 'default' : 'secondary'}>
            {project.status}
          </Badge>
          {otherTeams.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setMoveTeamOpen(true)}>
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              Move to Team
            </Button>
          )}
          <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
            <Trash2 className="mr-2 h-4 w-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>

      <Separator />

      <div className="grid gap-6 md:grid-cols-3">
        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Database className="h-4 w-4" />
            Database
          </div>
          <p className="mt-2 font-mono text-sm">{project.dbName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {project.dbHost}:{project.dbPort}
          </p>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Shield className="h-4 w-4" />
            Keycloak Realm
          </div>
          <p className="mt-2 font-mono text-sm">{project.keycloakRealm}</p>
        </div>

        <div className="rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Key className="h-4 w-4" />
            Anon Key
          </div>
          <p className="mt-2 truncate font-mono text-sm" title={project.anonKey}>
            {project.anonKey}
          </p>
        </div>

        {project.github?.connected && (
          <div className="rounded-lg border bg-card p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Github className="h-4 w-4" />
                GitHub
              </div>
              {gh?.repoUrl && (
                <a
                  href={gh.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            {gh?.owner && gh?.repo ? (
              <a
                href={gh.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block text-sm font-medium hover:underline"
              >
                {gh.owner}/{gh.repo}
              </a>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">Loading...</p>
            )}
            {gh?.branch && (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitBranch className="h-3 w-3" />
                {gh.branch}
              </div>
            )}

            {commits.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t pt-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Recent Commits
                </p>
                {commits.map((c) => (
                  <a
                    key={c.sha}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-2 rounded p-1 -mx-1 hover:bg-muted/50 transition-colors"
                  >
                    <GitCommit className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs truncate">{c.message}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {c.author} &middot; {timeAgo(c.date)}
                      </p>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {project.vercel?.connected && (
          <div className="rounded-lg border bg-card p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Triangle className="h-4 w-4" />
                Vercel
              </div>
              {vercelDashboardUrl && (
                <a
                  href={vercelDashboardUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            {vc?.projectName ? (
              <a
                href={vercelDashboardUrl || vc.projectUrl || '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 block text-sm font-medium hover:underline"
              >
                {vc.projectName}
              </a>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">Loading...</p>
            )}
            {vc?.projectUrl && (
              <a
                href={vc.projectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block text-xs text-muted-foreground hover:underline truncate"
              >
                {vc.projectUrl}
              </a>
            )}

            {deployments.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t pt-3">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Recent Deployments
                </p>
                {deployments.map((d) => (
                  <a
                    key={d.id}
                    href={d.url || vercelDashboardUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-2 rounded p-1 -mx-1 hover:bg-muted/50 transition-colors"
                  >
                    <Circle className={`h-2.5 w-2.5 mt-1 shrink-0 fill-current ${deployStateColor(d.state)}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs truncate">
                        {d.commitMessage || 'No commit message'}
                      </p>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <Badge
                          variant={d.state === 'READY' ? 'default' : d.state === 'ERROR' ? 'destructive' : 'secondary'}
                          className="text-[9px] h-3.5 px-1"
                        >
                          {d.state}
                        </Badge>
                        {d.branch && <span>{d.branch}</span>}
                        <span>{timeAgo(d.createdAt)}</span>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {importLog && (
        <div className="rounded-lg border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <ScrollText className="h-4 w-4" />
                Supabase import log
              </div>
              {importLog.completedAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Completed {new Date(importLog.completedAt).toLocaleString()}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="font-normal">
                <Database className="mr-1 h-3 w-3" />
                {importLog.database.tables} tables
              </Badge>
              <Badge variant="secondary" className="font-normal">
                <Shield className="mr-1 h-3 w-3" />
                {importLog.auth.users} users
              </Badge>
              <Badge variant="secondary" className="font-normal">
                <HardDrive className="mr-1 h-3 w-3" />
                {importLog.storage.objects} files
              </Badge>
            </div>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {importLog.database.rows.toLocaleString()} rows copied &middot;{' '}
            {importLog.storage.buckets} storage bucket(s)
            {importLog.auth.skipped > 0 && (
              <>
                {' '}
                &middot; {importLog.auth.skipped} auth user(s) skipped
              </>
            )}
          </p>

          {(importLog.warnings.length > 0 ||
            importLog.database.failedTables.length > 0 ||
            importLog.auth.skipped > 0) && (
            <div
              className={`mt-4 rounded-lg border p-3 ${
                importLog.warnings.length > 0
                  ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
                  : 'border-border bg-muted/40'
              }`}
            >
              <p
                className={`mb-2 text-xs font-medium ${
                  importLog.warnings.length > 0
                    ? 'text-amber-800 dark:text-amber-400'
                    : 'text-muted-foreground'
                }`}
              >
                {importLog.warnings.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Errors &amp; warnings ({importLog.warnings.length})
                  </span>
                ) : (
                  'Import notes'
                )}
              </p>
              {importLog.warnings.length === 0 && importLog.auth.skipped > 0 && (
                <p className="mb-2 text-xs text-muted-foreground">
                  Auth: {importLog.auth.skipped} user(s) were not imported.
                </p>
              )}
              {importLog.warnings.length === 0 &&
                importLog.database.failedTables.length > 0 && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    Database: could not import{' '}
                    {importLog.database.failedTables.length} table(s):{' '}
                    {importLog.database.failedTables.join(', ')}
                  </p>
                )}
              {importLog.warnings.length > 0 && (
                <ul
                  className="max-h-56 space-y-1.5 overflow-y-auto pr-1 text-xs text-amber-900 dark:text-amber-300"
                  aria-label="Import log messages"
                >
                  {importLog.warnings.map((line, i) => (
                    <li
                      key={i}
                      className="flex gap-2 border-b border-amber-200/60 pb-1.5 last:border-0 dark:border-amber-800/50"
                    >
                      <span className="shrink-0 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                        {i + 1}.
                      </span>
                      <span className="min-w-0 break-words">{line}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Move to Team Dialog */}
      <Dialog open={moveTeamOpen} onOpenChange={setMoveTeamOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move Project to Team</DialogTitle>
            <DialogDescription>
              Select a team to move <strong>&quot;{project.name}&quot;</strong> to. The project will be removed from the current team and its folder assignment will be cleared.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-64 overflow-y-auto">
            {otherTeams.map((team) => (
              <button
                key={team.id}
                onClick={() => setSelectedTeam(team)}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors hover:bg-accent ${selectedTeam?.id === team.id ? 'border-primary bg-primary/5 font-medium' : 'border-transparent'}`}
              >
                <span className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {team.name.charAt(0).toUpperCase()}
                </span>
                <span className="flex-1 text-left truncate">{team.name}</span>
                {selectedTeam?.id === team.id && (
                  <span className="text-primary text-xs">✓</span>
                )}
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMoveTeamOpen(false); setSelectedTeam(null); }}>
              Cancel
            </Button>
            <Button
              onClick={handleMoveToTeam}
              disabled={!selectedTeam || movingTeam}
            >
              <ArrowRightLeft className="mr-2 h-4 w-4" />
              {movingTeam ? 'Moving…' : 'Move Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
