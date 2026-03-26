'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project, GitHubCommit, VercelDeployment, GitHubIntegration, VercelIntegration } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Database, Github, Key, Shield, Trash2, Triangle,
  GitBranch, GitCommit, Circle, ExternalLink,
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
    if (!confirm(`Delete "${project.name}"? This cannot be undone.`)) return;

    setDeleting(true);
    try {
      await api.projects.delete(project.id);
      toast.success('Project deleted');
      router.push('/dashboard');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }

  const gh = githubStatus?.connected ? githubStatus : project.github;
  const vc = vercelStatus?.connected ? vercelStatus : project.vercel;
  const vercelDashboardUrl = vercelStatus?.dashboardUrl || null;

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
    </div>
  );
}
