'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project, ProjectActivityItem } from '@/lib/types';
import {
  loadStoredSupabaseImportLog,
  mergeSupabaseImportLogSources,
  shouldShowSupabaseImportLog,
} from '@/lib/import-log-storage';
import { Button } from '@/components/ui/button';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { ProjectImportLogCard } from '@/components/project-import-log-card';
import { ProjectActivityTimeline } from '@/components/project-activity-timeline';
import { ScrollText } from 'lucide-react';

export default function ProjectLogsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [activity, setActivity] = useState<ProjectActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [reimportOpen, setReimportOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.projects.get(id), api.projects.listActivity(id)])
      .then(([p, a]) => {
        if (!cancelled) {
          setProject(p);
          setActivity(a.items);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err.message);
          router.push('/dashboard/projects');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  if (loading || !project) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  const importLog = mergeSupabaseImportLogSources(
    project.supabaseImportLog,
    loadStoredSupabaseImportLog(project.id),
  );
  const importLogFromBrowser =
    (project.supabaseImportLog === null || project.supabaseImportLog === undefined) &&
    importLog !== null;
  const showImportLog = importLog && shouldShowSupabaseImportLog(importLog);
  const hasActivity = activity.length > 0;

  return (
    <div className="flex w-full max-w-full min-w-0 flex-col gap-8 overflow-x-hidden pb-8">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <ScrollText className="h-5 w-5 shrink-0" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Project logs
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Timeline of actions on this project (imports, edits, SQL, GitHub,
            Vercel, auth settings). Supabase import detail appears below when
            available.
          </p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" asChild>
          <Link href={`/dashboard/projects/${project.id}`}>Back to overview</Link>
        </Button>
      </header>

      <section className="rounded-lg border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Newest first. Only actions performed after this feature was deployed
          appear here.
        </p>
        <div className="mt-4">
          <ProjectActivityTimeline items={activity} />
        </div>
      </section>

      {showImportLog ? (
        <section className="flex min-h-0 min-w-0 flex-col gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Supabase import detail
          </h2>
          <ProjectImportLogCard
            importLog={importLog}
            importLogFromBrowser={importLogFromBrowser}
            onReimport={() => setReimportOpen(true)}
            projectId={project.id}
            projectName={project.name}
            expandedLayout
            fillParentHeight
            className="min-h-[320px]"
          />
        </section>
      ) : !hasActivity ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center">
          <ScrollText className="mx-auto h-10 w-10 text-muted-foreground/60" />
          <p className="mt-2 text-sm font-medium text-foreground">
            No import summary yet
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Run a Supabase import from Connection or Overview to see the full
            import breakdown here.
          </p>
          <Button className="mt-4 shrink-0" size="sm" asChild>
            <Link href={`/dashboard/projects/${project.id}/connect`}>
              Go to Connection
            </Link>
          </Button>
        </div>
      ) : null}

      <CreateProjectDialog
        open={reimportOpen}
        onOpenChange={setReimportOpen}
        onCreated={() => router.refresh()}
        teamId={project.teamId}
        reimportTarget={
          reimportOpen ? { projectId: project.id, projectName: project.name } : null
        }
      />
    </div>
  );
}
