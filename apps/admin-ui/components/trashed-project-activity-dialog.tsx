'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ProjectActivityItem } from '@/lib/types';
import { formatDateTime } from '@/lib/format';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * The activity log of a project in the trash (#190). The project pages do not
 * open for a trashed project, so its history is read here until the purge.
 */
export function TrashedProjectActivityDialog({
  project,
  onOpenChange,
}: {
  project: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [items, setItems] = useState<ProjectActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    api.projects
      .listActivity(project.id, { page: 1, limit: 200 })
      .then((res) => !cancelled && setItems(res.items))
      .catch((err: any) => !cancelled && setError(err?.message || 'Could not load the activity'));
    return () => {
      cancelled = true;
    };
  }, [project]);

  return (
    <Dialog open={!!project} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Activity of {project?.name}</DialogTitle>
          <DialogDescription>Who did what, newest first. Kept while the project is in the trash.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : items === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity recorded.</p>
        ) : (
          <ul className="divide-y text-sm">
            {items.map((item) => (
              <li key={item.id} className="py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{item.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {item.actorName || 'System'}
                  {item.detail ? ` · ${item.detail}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
