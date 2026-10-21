'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, ExternalLink, GitBranch, Info, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import { api } from '@/lib/api';
import type { PreviewBranchListItem } from '@/lib/types';
import { useProject } from '@/contexts/project-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Same rule the API enforces (CreatePreviewBranchDto). */
const BRANCH_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

function SyncChip({ item }: { item: PreviewBranchListItem }) {
  if (item.syncStatus === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
        <Loader2 className="h-3 w-3 animate-spin" /> Copying
      </span>
    );
  }
  if (item.syncStatus === 'failed') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:bg-red-900/40 dark:text-red-300"
        title={item.syncError ?? undefined}
      >
        <XCircle className="h-3 w-3" /> Failed
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
      title={item.syncError ?? undefined}
    >
      <CheckCircle2 className="h-3 w-3" /> Ready
    </span>
  );
}

/**
 * Preview branches of a project: disposable child projects with their own
 * database, auth realm and keys, populated from this project's schema (and
 * optionally its rows). Used to try a migration or a feature against the real
 * structure without touching the project people depend on.
 */
export function ProjectBranchesPanel({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { project } = useProject();
  const [branches, setBranches] = useState<PreviewBranchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [dataMode, setDataMode] = useState<'schema' | 'full'>('schema');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const isBranch = !!project?.previewBranch;
  const isNoSql = project?.databaseType === 'NOSQL';
  const unavailable = isBranch || isNoSql;

  const load = useCallback(async () => {
    try {
      setBranches(await api.projects.listBranches(projectId));
    } catch (err: any) {
      toast.error(err?.message || 'Could not load preview branches');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!project) return;
    if (unavailable) {
      setLoading(false);
      return;
    }
    void load();
  }, [project, unavailable, load]);

  // A branch is populated in the background; refresh until none is still copying.
  const anyPending = branches.some((b) => b.syncStatus === 'pending');
  useEffect(() => {
    if (!anyPending) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [anyPending, load]);

  const nameValid = BRANCH_NAME_PATTERN.test(name);

  async function createBranch() {
    if (!nameValid) return;
    setCreating(true);
    try {
      await api.projects.createBranch(projectId, { name, dataMode });
      toast.success(`Preview branch "${name}" created — copying ${dataMode === 'full' ? 'schema and data' : 'schema'} now`);
      setDialogOpen(false);
      setName('');
      setDataMode('schema');
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not create the preview branch');
    } finally {
      setCreating(false);
    }
  }

  async function deleteBranch(item: PreviewBranchListItem) {
    const ok = await confirmDialog({
      title: `Delete preview branch "${item.branchName}"?`,
      description:
        'The branch project, its database and its auth realm move to the trash and are purged after 24 hours. This project is not affected.',
      confirmText: 'Delete branch',
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(item.id);
    try {
      await api.projects.deleteBranch(projectId, item.id);
      toast.success(`Preview branch "${item.branchName}" moved to trash`);
      await load();
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete the preview branch');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="rounded-xl border bg-card p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <GitBranch className="h-4 w-4" /> Preview branches
          </h2>
          <p className="text-xs text-muted-foreground">
            A branch is a separate project with its own database, auth realm and API keys, created from this
            project&apos;s schema (and optionally its data). Try a migration or a feature there; this project is never
            touched.
          </p>
        </div>
        {!unavailable && (
          <Button size="sm" onClick={() => setDialogOpen(true)} disabled={!project}>
            <Plus className="mr-2 h-4 w-4" />
            New branch
          </Button>
        )}
      </div>

      {isBranch && project?.previewBranch && (
        <div className="flex items-start gap-3 rounded-lg border p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            This project is itself a preview branch of{' '}
            <Link
              href={`/dashboard/projects/${project.previewBranch.parentProjectId}/branches`}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {project.previewBranch.parentName ?? 'its parent'}
            </Link>
            . Branches are one level deep; create new branches from the parent project.
          </p>
        </div>
      )}

      {!isBranch && isNoSql && (
        <div className="flex items-start gap-3 rounded-lg border p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>Preview branches are available for PostgreSQL projects only.</p>
        </div>
      )}

      {!unavailable && (
        <>
          {loading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading branches…
            </div>
          ) : branches.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No preview branches yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Branch</th>
                    <th className="py-2 pr-3 font-medium">Copied</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Created</th>
                    <th className="py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {branches.map((b) => (
                    <tr key={b.id} className="border-t align-top">
                      <td className="py-2 pr-3">
                        <p className="font-medium">{b.branchName}</p>
                        <p className="text-xs text-muted-foreground">{b.name}</p>
                        {b.syncStatus === 'failed' && b.syncError && (
                          <p className="mt-1 max-w-md text-xs text-red-700 dark:text-red-300">{b.syncError}</p>
                        )}
                        {b.syncStatus === 'ready' && b.syncError && (
                          <p className="mt-1 max-w-md text-xs text-amber-800 dark:text-amber-300">{b.syncError}</p>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs">{b.dataMode === 'full' ? 'Schema + data' : 'Schema only'}</td>
                      <td className="py-2 pr-3">
                        <SyncChip item={b} />
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-xs">{new Date(b.createdAt).toLocaleString()}</td>
                      <td className="py-2">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => router.push(`/dashboard/projects/${b.id}`)}
                          >
                            <ExternalLink className="mr-2 h-3.5 w-3.5" />
                            Open
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void deleteBranch(b)}
                            disabled={deletingId === b.id}
                            title="Move this branch to the trash"
                          >
                            {deletingId === b.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Branches do not count toward the plan&apos;s project limit; each project can keep a few live branches at a
            time. Deleting this project moves its branches to the trash too; restoring it does not bring them back.
          </p>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => !creating && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New preview branch</DialogTitle>
            <DialogDescription>
              Creates a separate project from {project?.name ?? 'this project'}. The copy runs in the background; the
              branch shows &quot;Copying&quot; until it is ready.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="branch-name">Branch name</Label>
              <Input
                id="branch-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder="pr-42"
                maxLength={40}
                autoFocus
              />
              <p className={`text-xs ${name && !nameValid ? 'text-red-600' : 'text-muted-foreground'}`}>
                2-40 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit.
              </p>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">What to copy</legend>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm">
                <input
                  type="radio"
                  name="branch-data-mode"
                  className="mt-1"
                  checked={dataMode === 'schema'}
                  onChange={() => setDataMode('schema')}
                />
                <span>
                  <span className="font-medium">Schema only</span>
                  <span className="block text-xs text-muted-foreground">
                    Tables, views, functions and policies, with no rows. Fast at any size.
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm">
                <input
                  type="radio"
                  name="branch-data-mode"
                  className="mt-1"
                  checked={dataMode === 'full'}
                  onChange={() => setDataMode('full')}
                />
                <span>
                  <span className="font-medium">Schema and data</span>
                  <span className="block text-xs text-muted-foreground">
                    Every row as of now. Large databases are refused; branch schema-only instead.
                  </span>
                </span>
              </label>
            </fieldset>
            <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              Not copied: auth users, storage files, flows and realtime settings. The branch starts with an empty auth
              realm and empty buckets, and gets its own API keys.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void createBranch()} disabled={!nameValid || creating}>
              {creating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                'Create branch'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
