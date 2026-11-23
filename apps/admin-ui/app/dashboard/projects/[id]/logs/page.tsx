'use client';

import { useEffect, useRef, useState } from 'react';
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
import { subscribebasefyioRealtime } from '@/lib/basefyio-realtime';
import type { RealtimeEventEnvelope } from '@/lib/realtime-types';

const PAGE_SIZE = 50;

/** Event groups for the type filter: prefixes of the activity kinds. */
const KIND_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'sql.', label: 'SQL' },
  { value: 'table.', label: 'Tables' },
  { value: 'auth', label: 'Auth' },
  { value: 'storage.', label: 'Storage' },
  { value: 'flow.', label: 'Flows' },
  { value: 'embeddings.', label: 'Embeddings' },
  { value: 'project', label: 'Project and backups' },
  { value: 'collection.', label: 'Collections' },
];

export default function ProjectLogsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [activity, setActivity] = useState<ProjectActivityItem[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [page, setPage] = useState(1);
  const filtered = !!(query || kind || from || to);
  const [exporting, setExporting] = useState(false);

  /** CSV of the events the current filters match, newest first, at most 5,000 (#27). */
  async function exportCsv() {
    setExporting(true);
    try {
      const rows: ProjectActivityItem[] = [];
      for (let p = 1; p <= 10; p++) {
        const a = await api.projects.listActivity(id, { page: p, limit: 500, q: query, kind, from, to });
        rows.push(...a.items);
        if (p >= a.totalPages) break;
      }
      const cell = (v: unknown) => {
        const t = v == null ? '' : String(v);
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const csv = [
        ['time', 'type', 'title', 'detail', 'by'].join(','),
        ...rows.map((r) => [r.createdAt, r.kind, r.title, r.detail ?? '', r.actorName ?? r.userId ?? 'System'].map(cell).join(',')),
      ].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-logs-${id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`${rows.length.toLocaleString('en-US')} events exported${rows.length >= 5000 ? ' (first 5,000)' : ''}`);
    } catch (err: any) {
      toast.error(err.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }
  const topRef = useRef<HTMLElement | null>(null);

  // Debounced server-side search over the whole history (#27).
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
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

  // Live updates: subscribe to the project channel and prepend new activity
  // events as they happen. We only mutate the list on page 1 — on deeper
  // pages the user is reading historical events and a live insert would push
  // their cursor around. Total + totalPages get bumped regardless so the
  // pagination header stays accurate.
  // Stable refs so the realtime subscription doesn't re-subscribe on every state change
  const pageRef = useRef(page);
  pageRef.current = page;
  const totalActivityRef = useRef(totalActivity);
  totalActivityRef.current = totalActivity;
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  useEffect(() => {
    if (loading || !project) return;
    const unsubscribe = subscribebasefyioRealtime(
      `project:${id}`,
      (event: RealtimeEventEnvelope) => {
        if (event.entityType !== 'project_activity') return;
        if (event.action !== 'activity_appended') return;
        const payload = (event.payload || {}) as {
          kind?: string;
          title?: string;
          detail?: string | null;
          actorName?: string;
        };
        const newItem: ProjectActivityItem = {
          id: event.entityId,
          kind: payload.kind || 'unknown',
          title: payload.title || '(no title)',
          detail: payload.detail ?? null,
          metadata: null,
          createdAt: event.emittedAt,
          userId: event.actorUserId ?? null,
          actorName: payload.actorName,
        };
        // A filtered view is refetched instead; a live row may not match it.
        if (filteredRef.current) return;
        setTotalActivity((t) => t + 1);
        setTotalPages(() => Math.max(1, Math.ceil((totalActivityRef.current + 1) / PAGE_SIZE)));
        if (pageRef.current !== 1) return;
        setActivity((prev) => {
          if (prev.some((p) => p.id === newItem.id)) return prev;
          return [newItem, ...prev].slice(0, PAGE_SIZE);
        });
      },
    );
    return () => {
      unsubscribe?.();
    };
  }, [id, loading, project]);

  // Whenever the page number changes (after initial load), fetch that page.
  // Skip the very first render so we don't double-fetch alongside the initial
  // load above. Activity is already populated from the initial bundle.
  useEffect(() => {
    if (loading) return; // initial load handles page 1
    let cancelled = false;
    setActivityLoading(true);
    api.projects
      .listActivity(id, { page, limit: PAGE_SIZE, q: query, kind, from, to })
      .then((a) => {
        if (cancelled) return;
        setActivity(a.items);
        setTotalPages(a.totalPages);
        setTotalActivity(a.total);
        topRef.current?.scrollIntoView({ block: 'start' });
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
    // Intentionally exclude `loading` — only page, filter or refresh changes refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, page, query, kind, from, to, reloadTick]);

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
  const pagedActivity = activity;
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

      <section ref={topRef} className="scroll-mt-4 rounded-lg border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Activity</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Newest first. {totalActivity.toLocaleString('en-US')}{' '}
          {totalActivity === 1 ? 'event' : 'events'}{' '}recorded. Use the page
          controls below to scroll back through the project&apos;s full history.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search all events (title, detail, type)..."
            aria-label="Search all events"
            className="max-w-sm"
          />
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setPage(1);
            }}
            aria-label="Event type"
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {KIND_FILTERS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            From
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} className="h-9 w-36" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            To
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} className="h-9 w-36" />
          </label>
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadTick((t) => t + 1)}>
            Refresh
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
          {filtered && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                setQuery('');
                setKind('');
                setFrom('');
                setTo('');
                setPage(1);
              }}
            >
              Clear filters
            </Button>
          )}
          <p className="ml-auto text-xs text-muted-foreground">
            {totalActivity.toLocaleString('en-US')} {filtered ? 'matching' : 'total'}
          </p>
        </div>
        <div className="relative mt-4">
          {activityLoading && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-card/60">
              <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            </div>
          )}
          <ProjectActivityTimeline
            items={pagedActivity}
            emptyText={filtered ? 'No events match these filters.' : undefined}
          />
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
