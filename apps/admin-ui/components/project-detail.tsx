'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  type Project,
  type GitHubCommit,
  type VercelDeployment,
  type GitHubIntegration,
  type VercelIntegration,
  type Team,
} from '@/lib/types';
import {
  loadStoredSupabaseImportLog,
  mergeSupabaseImportLogSources,
  shouldShowSupabaseImportLog,
} from '@/lib/import-log-storage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Database, Github, Key, Shield, Trash2, Triangle,
  GitBranch, GitCommit, Circle, ExternalLink, ArrowRightLeft,
  RefreshCw,
} from 'lucide-react';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { ProjectAdvisorSection } from '@/components/project-advisor-section';
import { ProjectImportLogCard } from '@/components/project-import-log-card';

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

const DELETE_REASONS = [
  { code: 'performance', label: 'Performance or reliability insufficient.' },
  { code: 'trust', label: 'I lost trust in the company or its future direction.' },
  { code: 'exploring', label: 'I was just exploring, or it was a hobby/student project.' },
  { code: 'cancelled', label: 'My project was cancelled or put on hold.' },
  { code: 'support', label: 'I was not satisfied with the customer support I received.' },
  { code: 'pricing_unpredictable', label: 'The pricing is unpredictable and hard to budget for.' },
  { code: 'too_expensive', label: 'Too expensive' },
  { code: 'missing_feature', label: 'Kolaybase is missing a specific feature I need.' },
  { code: 'company_closed', label: 'My company went out of business or was acquired.' },
  { code: 'difficult', label: 'I found it difficult to use or build with.' },
  { code: 'none', label: 'None of the above' },
] as const;

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
  const [reimportOpen, setReimportOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteReasonCode, setDeleteReasonCode] = useState<string>('none');
  const [deleteDetails, setDeleteDetails] = useState('');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

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
    if (deleteConfirmText.trim() !== project.name) {
      toast.error(`Type "${project.name}" to confirm`);
      return;
    }

    setDeleting(true);
    try {
      const selectedReason = DELETE_REASONS.find((x) => x.code === deleteReasonCode);
      await api.projects.delete(project.id, {
        reasonCode: deleteReasonCode,
        reasonLabel: selectedReason?.label || 'None of the above',
        details: deleteDetails.trim() || undefined,
      });
      toast.success('Project moved to trash');
      setDeleteDialogOpen(false);
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
  const importLog = mergeSupabaseImportLogSources(
    project.supabaseImportLog,
    loadStoredSupabaseImportLog(project.id),
  );
  const importLogFromBrowser =
    (project.supabaseImportLog === null || project.supabaseImportLog === undefined) &&
    importLog !== null;
  const reimportSource =
    project.importSource === 'SUPABASE'
      ? 'supabase'
      : project.importSource === 'ZIP'
        ? 'zip'
        : null;
  const reimportLabel =
    reimportSource === 'zip' ? 'Re-import from ZIP' : 'Re-import Supabase';

  return (
    <div className="space-y-5">
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
          {reimportSource && (
            <Button variant="outline" size="sm" onClick={() => setReimportOpen(true)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {reimportLabel}
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={deleting}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </div>
      </div>

      <Separator />

      <ProjectAdvisorSection
        project={project}
        importLog={importLog}
        githubIntegration={gh ?? undefined}
        vercelIntegration={vc ?? undefined}
      />

      <div className="kb-grid-row-hover grid gap-5 md:grid-cols-3">
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

        {importLog && shouldShowSupabaseImportLog(importLog) && (
          <div className="min-w-0 md:col-span-3">
            <ProjectImportLogCard
              importLog={importLog}
              importLogFromBrowser={importLogFromBrowser}
              onReimport={() => setReimportOpen(true)}
              projectId={project.id}
              projectName={project.name}
            />
          </div>
        )}
      </div>

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

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          setDeleteDialogOpen(open);
          if (!open) {
            setDeleteDetails('');
            setDeleteConfirmText('');
            setDeleteReasonCode('none');
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirm deletion of {project.name}</DialogTitle>
            <DialogDescription>
              This will permanently delete project resources after trash retention.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              <p className="font-semibold">This will permanently delete the {project.name}</p>
              <p className="text-red-800">All project data will be lost, and cannot be undone.</p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">What made you decide to delete your project?</p>
              <div className="flex flex-wrap gap-2">
                {DELETE_REASONS.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => setDeleteReasonCode(r.code)}
                    className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                      deleteReasonCode === r.code
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                We appreciate your perspective. What aspects felt too high or problematic?
              </label>
              <textarea
                value={deleteDetails}
                onChange={(e) => setDeleteDetails(e.target.value)}
                className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Optional details..."
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">
                Type {project.name} to confirm.
              </label>
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={project.name}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting || deleteConfirmText.trim() !== project.name}
            >
              {deleting ? 'Deleting...' : 'I understand, delete this project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateProjectDialog
        open={reimportOpen}
        onOpenChange={setReimportOpen}
        onCreated={() => router.refresh()}
        teamId={project.teamId}
        reimportSource={reimportSource}
        reimportTarget={
          reimportOpen && reimportSource
            ? { projectId: project.id, projectName: project.name }
            : null
        }
      />
    </div>
  );
}
