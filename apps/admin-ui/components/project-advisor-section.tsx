'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import type {
  Project,
  ProjectSupabaseImportLog,
  GitHubIntegration,
  VercelIntegration,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Activity,
  CheckCircle2,
  Database,
  Github,
  Lightbulb,
  Shield,
  Sparkles,
  Users,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type AdvisorCategory = 'SECURITY' | 'PERFORMANCE' | 'DATABASE' | 'AUTH' | 'INTEGRATIONS';

export interface AdvisorItem {
  id: string;
  category: AdvisorCategory;
  title: string;
  body: string;
  cta?: { label: string; href: string };
}

const categoryStyles: Record<
  AdvisorCategory,
  { bar: string; label: string; icon: typeof Shield }
> = {
  SECURITY: {
    bar: 'bg-amber-500',
    label: 'text-amber-700 dark:text-amber-400',
    icon: Shield,
  },
  PERFORMANCE: {
    bar: 'bg-sky-500',
    label: 'text-sky-700 dark:text-sky-400',
    icon: Zap,
  },
  DATABASE: {
    bar: 'bg-violet-500',
    label: 'text-violet-700 dark:text-violet-400',
    icon: Database,
  },
  AUTH: {
    bar: 'bg-emerald-500',
    label: 'text-emerald-700 dark:text-emerald-400',
    icon: Users,
  },
  INTEGRATIONS: {
    bar: 'bg-cyan-500',
    label: 'text-cyan-700 dark:text-cyan-400',
    icon: Sparkles,
  },
};

function classifyWarning(text: string): AdvisorCategory {
  const t = text.toLowerCase();
  if (
    t.includes('rls') ||
    t.includes('permission') ||
    t.includes('security') ||
    t.includes('jwt') ||
    t.includes('unauthorized') ||
    t.includes('403')
  ) {
    return 'SECURITY';
  }
  if (t.includes('timeout') || t.includes('slow') || t.includes('rate')) {
    return 'PERFORMANCE';
  }
  return 'DATABASE';
}

export function buildAdvisorItems(
  project: Project,
  importLog: ProjectSupabaseImportLog | null,
  basePath: string,
): AdvisorItem[] {
  const items: AdvisorItem[] = [];

  if (project.status === 'PAUSED') {
    items.push({
      id: 'state-paused',
      category: 'PERFORMANCE',
      title: 'Project is paused',
      body: 'Database and API access may be limited until the project is active again.',
    });
  }

  const hasImport = !!importLog?.completedAt || (importLog?.database.tables ?? 0) > 0;

  if (!hasImport) {
    items.push({
      id: 'no-import',
      category: 'INTEGRATIONS',
      title: 'Import from Supabase',
      body: 'Copy tables, auth users, and storage from your Supabase project into Basefyio for a hosted mirror.',
      cta: { label: 'Connection & import', href: `${basePath}/connect` },
    });
  }

  if (importLog?.database.failedTables?.length) {
    for (const table of importLog.database.failedTables.slice(0, 3)) {
      items.push({
        id: `fail-${table}`,
        category: 'DATABASE',
        title: `Table “${table}” failed to import`,
        body: 'Check Supabase RLS, service role access, or add the database password on re-import for direct Postgres copy.',
        cta: { label: 'Re-import', href: basePath },
      });
    }
  }

  if (importLog && importLog.auth.skipped > 0) {
    items.push({
      id: 'auth-skipped',
      category: 'AUTH',
      title: `${importLog.auth.skipped} auth user(s) skipped`,
      body: 'Users that already exist in Keycloak or lack an email are skipped. Review import warnings for details.',
      cta: { label: 'Auth settings', href: `${basePath}/auth` },
    });
  }

  if (importLog?.warnings?.length) {
    importLog.warnings.slice(0, 6).forEach((w, i) => {
      const cat = classifyWarning(w);
      const short =
        w.length > 140 ? `${w.slice(0, 137)}…` : w;
      items.push({
        id: `warn-${i}-${w.slice(0, 24)}`,
        category: cat,
        title:
          cat === 'SECURITY'
            ? 'Security / access note'
            : cat === 'PERFORMANCE'
              ? 'Import performance note'
              : 'Import note',
        body: short,
        cta: { label: 'View log', href: `${basePath}/logs` },
      });
    });
  }

  if (!project.github?.connected) {
    items.push({
      id: 'github',
      category: 'INTEGRATIONS',
      title: 'Connect GitHub',
      body: 'Link a repository to track commits and enable deploy workflows from the Integrations page.',
      cta: { label: 'Integrations', href: `${basePath}/integrations` },
    });
  }

  if (!project.vercel?.connected) {
    items.push({
      id: 'vercel',
      category: 'INTEGRATIONS',
      title: 'Connect Vercel',
      body: 'See deployment status next to your project and open the Vercel dashboard in one click.',
      cta: { label: 'Integrations', href: `${basePath}/integrations` },
    });
  }

  return items.slice(0, 18);
}

function VercelMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 76 65" fill="currentColor" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M37.5274 0L75.0548 65H0L37.5274 0Z" />
    </svg>
  );
}

function githubLinkTarget(g: GitHubIntegration): string {
  if (g.repoUrl?.trim()) return g.repoUrl.trim();
  if (g.owner && g.repo) return `https://github.com/${g.owner}/${g.repo}`;
  return '';
}

function githubDisplayName(g: GitHubIntegration): string {
  if (g.owner && g.repo) return `${g.owner}/${g.repo}`;
  if (g.repo) return g.repo;
  return 'GitHub';
}

function vercelLinkTarget(v: VercelIntegration): string {
  return (v.projectUrl || v.dashboardUrl || '').trim();
}

function vercelDisplayName(v: VercelIntegration): string {
  return (v.projectName || v.projectId || 'Vercel').trim();
}

export function ProjectAdvisorSection({
  project,
  importLog,
  githubIntegration,
  vercelIntegration,
}: {
  project: Project;
  importLog: ProjectSupabaseImportLog | null;
  /** Fresh GitHub status from API when available (falls back to `project.github`). */
  githubIntegration?: GitHubIntegration | null;
  vercelIntegration?: VercelIntegration | null;
}) {
  const gh = githubIntegration ?? project.github;
  const vc = vercelIntegration ?? project.vercel;
  const integrationsPath = `/dashboard/projects/${project.id}/integrations`;

  const items = useMemo(
    () =>
      buildAdvisorItems(
        project,
        importLog,
        `/dashboard/projects/${project.id}`,
      ),
    [project, importLog],
  );

  return (
    <div className="space-y-4">
      <div className="basefyio-grid-row-hover grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Status
          </p>
          <p className="mt-1.5 text-sm font-medium">{project.status}</p>
        </div>
        <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Last import
          </p>
          <p className="mt-1.5 text-sm font-medium">
            {importLog?.completedAt
              ? new Date(importLog.completedAt).toLocaleString()
              : '—'}
          </p>
        </div>
        <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Integrations
          </p>
          {gh?.connected || vc?.connected ? (
            <div className="mt-1.5 flex flex-col gap-1.5">
              {gh?.connected && (
                <a
                  href={githubLinkTarget(gh) || integrationsPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex min-h-8 items-center gap-2 rounded-md text-sm font-medium text-foreground transition-colors hover:bg-muted/80 -mx-1 px-1 py-0.5"
                >
                  <Github className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  <span className="min-w-0 truncate underline-offset-2 group-hover:underline">
                    {githubDisplayName(gh)}
                  </span>
                </a>
              )}
              {vc?.connected && (
                <a
                  href={vercelLinkTarget(vc) || integrationsPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex min-h-8 items-center gap-2 rounded-md text-sm font-medium text-foreground transition-colors hover:bg-muted/80 -mx-1 px-1 py-0.5"
                >
                  <VercelMark className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  <span className="min-w-0 truncate underline-offset-2 group-hover:underline">
                    {vercelDisplayName(vc)}
                  </span>
                </a>
              )}
            </div>
          ) : (
            <p className="mt-1.5 text-sm font-medium text-muted-foreground">None linked</p>
          )}
        </div>
        <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Data snapshot
          </p>
          <p className="mt-1.5 text-sm font-medium">
            {importLog
              ? `${importLog.database.tables} tables · ${importLog.database.rows.toLocaleString()} rows`
              : '—'}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Advisor</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {items.length} {items.length === 1 ? 'item' : 'items'}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            Suggestions for this project
          </div>
        </div>

        {items.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-8 text-sm text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 shrink-0 text-emerald-500/90" />
            <div>
              <p className="font-medium text-foreground">No issues detected</p>
              <p className="mt-0.5 text-xs">
                Import data and connect integrations to get deeper checks. Re-import after
                changing Supabase to refresh this list.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto p-4 pb-5">
            {items.map((item) => {
              const cfg = categoryStyles[item.category];
              const Icon = cfg.icon;
              return (
                <article
                  key={item.id}
                  className="flex w-[min(100%,280px)] shrink-0 flex-col rounded-lg border bg-background shadow-sm"
                >
                  <div
                    className={cn('h-1 w-full rounded-t-lg', cfg.bar)}
                    aria-hidden
                  />
                  <div className="flex flex-1 flex-col p-3 pt-3">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider">
                      <Icon className={cn('h-3 w-3', cfg.label)} />
                      <span className={cfg.label}>{item.category}</span>
                    </div>
                    <h3 className="mt-2 text-sm font-semibold leading-snug">
                      {item.title}
                    </h3>
                    <p className="mt-1.5 flex-1 text-xs leading-relaxed text-muted-foreground">
                      {item.body}
                    </p>
                    {item.cta && (
                      <Button variant="secondary" size="sm" className="mt-3 h-8 w-full text-xs" asChild>
                        <Link href={item.cta.href}>{item.cta.label}</Link>
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
