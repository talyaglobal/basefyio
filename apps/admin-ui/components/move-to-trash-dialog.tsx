'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Why a project is deleted; sent with the request and shown in the console's Deletion Reasons. */
export const DELETE_REASONS = [
  { code: 'performance', label: 'Performance or reliability insufficient.' },
  { code: 'trust', label: 'I lost trust in the company or its future direction.' },
  { code: 'exploring', label: 'I was just exploring, or it was a hobby/student project.' },
  { code: 'cancelled', label: 'My project was cancelled or put on hold.' },
  { code: 'support', label: 'I was not satisfied with the customer support I received.' },
  { code: 'pricing_unpredictable', label: 'The pricing is unpredictable and hard to budget for.' },
  { code: 'too_expensive', label: 'Too expensive' },
  { code: 'missing_feature', label: 'basefyio is missing a specific feature I need.' },
  { code: 'company_closed', label: 'My company went out of business or was acquired.' },
  { code: 'difficult', label: 'I found it difficult to use or build with.' },
  { code: 'none', label: 'None of the above' },
] as const;

/** How long a project stays in trash before it is purged. One figure for every screen (#28). */
export const TRASH_RETENTION_HOURS = 24;

/**
 * The one "move a project to trash" dialog (#28), used from the project Overview,
 * the Projects list menu and project Settings: the same retention, a reason,
 * the project name typed to confirm, and a red button.
 */
export function MoveToTrashDialog({
  project,
  open,
  onOpenChange,
  onMoved,
}: {
  project: { id: string; name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMoved: (projectId: string) => void;
}) {
  // '' = no reason chosen; stored apart from "None of the above" (#190).
  const [reason, setReason] = useState<string>('');
  const [details, setDetails] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setReason('');
      setDetails('');
      setTyped('');
    }
  }, [open, project?.id]);

  if (!project) return null;
  const matches = typed.trim() === project.name;

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    try {
      const picked = DELETE_REASONS.find((r) => r.code === reason);
      await api.projects.delete(project.id, {
        reasonCode: picked ? picked.code : undefined,
        reasonLabel: picked ? picked.label : undefined,
        details: details.trim() || undefined,
      });
      toast.success(`"${project.name}" moved to trash`);
      onOpenChange(false);
      onMoved(project.id);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to move the project to trash');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Move {project.name} to trash</DialogTitle>
          <DialogDescription>
            The project stops working at once and stays in trash for {TRASH_RETENTION_HOURS} hours. Until then the team
            owner can restore it from Projects → Trash; after that it is deleted permanently with all its data.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            After {TRASH_RETENTION_HOURS} hours in trash, the database, files, users and settings of {project.name} cannot be
            recovered.
          </div>

          <div className="space-y-2">
            <p className="text-sm font-semibold">Why are you deleting it? (optional)</p>
            <div className="flex flex-wrap gap-2">
              {DELETE_REASONS.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => setReason(reason === r.code ? '' : r.code)}
                  aria-pressed={reason === r.code}
                  className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                    reason === r.code ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {reason !== 'none' && (
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                aria-label="Anything else you want to tell us"
                className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Anything else you want to tell us (optional)"
              />
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="trash-confirm-name" className="text-sm font-medium">
              Type <span className="font-semibold">{project.name}</span> to confirm.
            </label>
            <Input
              id="trash-confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Project name"
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy || !matches}>
            {busy ? 'Moving…' : 'Move to trash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
