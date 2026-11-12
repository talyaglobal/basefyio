'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { ProjectActivityItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { localZoneLabel } from '@/lib/time-zone';

const PAGE_SIZE = 50;

/**
 * What a project page shows once the project is in the trash: a clear notice
 * and the project's activity history, read-only. Opening a trashed project
 * used to bounce silently to the project list, so nobody could review who did
 * what before the deletion — not even inside the restore window.
 */
export function TrashedProjectActivity({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ProjectActivityItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (pg: number) => {
      setLoading(true);
      try {
        const res = await api.projects.listActivity(projectId, { page: pg, limit: PAGE_SIZE });
        setItems(res.items);
        setTotalPages(res.totalPages);
        setPage(res.page);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <Link
        href="/dashboard/projects"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Projects
      </Link>
      <div className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <Trash2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">This project is in the trash.</p>
          <p className="mt-0.5">
            Its activity history stays readable here. Restore it from the trash on the projects page
            to work with it again.
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Activity</h2>
          <span className="text-xs text-muted-foreground">Times in {localZoneLabel()}</span>
        </div>
        {loading ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No activity recorded.</p>
        ) : (
          <ul className="divide-y">
            {items.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-4 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">{a.title}</p>
                  {a.detail && <p className="truncate text-xs text-muted-foreground">{a.detail}</p>}
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <p>{a.actorName || 'System or API key'}</p>
                  <p>{new Date(a.createdAt).toLocaleString()}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t px-4 py-2">
            <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => load(page - 1)}>
              Previous
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button size="sm" variant="outline" disabled={page >= totalPages || loading} onClick={() => load(page + 1)}>
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
