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
import { Input } from '@/components/ui/input';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { ProjectImportLogCard } from '@/components/project-import-log-card';
import { ProjectActivityTimeline } from '@/components/project-activity-timeline';
import { ScrollText } from 'lucide-react';

const PAGE_SIZE = 50;

export default function ProjectLogsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [activity, setActivity] = useState<ProjectActivityItem[]>([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalActivity, setTotalActivity] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(false);
  const [reimportOpen, setReimportOpen] = useState(false);

  // Initial: project + first page of activity in parallel.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.projects.get(id),
      api.projects.listActivity(id, { page: 1, limit: PAGE_SIZE }),
    ])
      .then(([p, a]) => {
        if (!cancelled) {
          setProject(p);
          setActivity(a.items);
          setTotalPages(a.totalPages);
          setTotalActivity(a.total);
          setPage(a.page);
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

  // Whenever the page number changes (after initial load), fetch that page.
  // Skip the very first render so we don't double-fetch alongside the initial
  // load above. Activity is already populated from the initial bundle.
  useEffect(() => {
    if (loading) return; // initial load handles page 1
    let cancelled = false;
    setActivityLoading(true);
    api.projects
      .listActivity(id, { page, limit: PAGE_SIZE })
      .then((a) => {
        if (cancelled) return;
        setActivity(a.items);
        setTotalPages(a.totalPages);
        setTotalActivity(a.total);
      })
      .catch((err) => {
        if (!cancelled) toast.error(err.message);
      })
      .finally(() => {
        if (!cancelled) setActivityLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally exclude `loading` — we only want page changes to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, page]);

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
  // Search filters only the current page client-side. With server-side paging
  // we no longer have the full history in memory; that's the tradeoff for
  // being able to scroll to the very first event in a project with 10k+ logs.
  const normalizedSearch = search.trim().toLowerCase();
  const pagedActivity = activity.filter((item) => {
    if (!normalizedSearch) return true;
    const haystack = [
      item.kind,
      item.title,
      item.detail || '',
      item.createdAt,
      JSON.stringify(item.metadata || {}),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalizedSearch);
  });
  const safePage = Math.min(page, totalPages);

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
          Newest first. {totalActivity.toLocaleString('tr-TR')}{' '}
          {totalActivity === 1 ? 'event' : 'events'} recorded. Use the page
          controls below to scroll back through the project&apos;s full history.
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter this page (title, detail, type)..."
            className="max-w-sm"
          />
          <p className="text-xs text-muted-foreground">
            Showing {pagedActivity.length} of {activity.length} on this page
            {' · '}
            {totalActivity.toLocaleString('tr-TR')} total
          </p>
        </div>
        <div className="relative mt-4">
          {activityLoading && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-card/60">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          )}
          <ProjectActivityTimeline items={pagedActivity} />
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Page {safePage} / {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
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
jectActivityTimeline items={pagedActivity} />
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Page {safePage} / {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
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
