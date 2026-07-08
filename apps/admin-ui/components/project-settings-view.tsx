'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project, ProjectFolder, ProjectTag, Team } from '@/lib/types';
import { useProject } from '@/contexts/project-context';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ArrowLeft, ArrowRightLeft, Check, Loader2, Power, Trash2, TriangleAlert } from 'lucide-react';

const settingsFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200, 'Name is too long'),
  description: z
    .string()
    .max(8000, 'Description is too long')
    .transform((s) => (s.trim() === '' ? null : s)),
});

const NONE_FOLDER = '__none__';

function tagIdsFromProject(project: Project): string[] {
  return (project.tags ?? []).map((a) => a.tag.id);
}

export function ProjectSettingsView() {
  const router = useRouter();
  const { project, loading, refreshProject } = useProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [allTags, setAllTags] = useState<ProjectTag[]>([]);
  const [loadMeta, setLoadMeta] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setDescription(project.description ?? '');
    setFolderId(project.folderId ?? null);
    setTagIds(tagIdsFromProject(project));
  }, [project]);

  const loadFoldersTags = useCallback(async () => {
    if (!project?.teamId) return;
    setLoadMeta(true);
    try {
      const [f, t] = await Promise.all([
        api.folders.list(project.teamId),
        api.tags.list(project.teamId),
      ]);
      setFolders(f);
      setAllTags(t);
    } catch {
      toast.error('Could not load folders or tags');
    } finally {
      setLoadMeta(false);
    }
  }, [project?.teamId]);

  useEffect(() => {
    loadFoldersTags();
  }, [loadFoldersTags]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    const parsed = settingsFormSchema.safeParse({ name, description });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Invalid form');
      return;
    }
    setSaving(true);
    try {
      await api.projects.update(project.id, {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        folderId,
        tags: tagIds,
      });
      toast.success('Settings saved');
      await refreshProject?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  function toggleTag(id: string) {
    setTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  if (loading || !project) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Project settings</h1>
          <p className="text-sm text-muted-foreground">
            Everything about this project — details, organization, data limits, the team it
            belongs to, and its lifecycle. Connection strings and API keys stay on the
            Connection page.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => router.back()} className="shrink-0">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>

      <form onSubmit={handleSave} className="space-y-8">
        <section className="rounded-xl border bg-card p-6 space-y-4">
          <h2 className="text-base font-semibold">General</h2>
          <div className="space-y-2">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Optional"
              className="resize-y min-h-[100px]"
            />
          </div>
        </section>

        <section className="rounded-xl border bg-card p-6 space-y-4">
          <h2 className="text-base font-semibold">Organization</h2>
          {loadMeta ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading folders and tags…
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Folder</Label>
                <Select
                  value={folderId ?? NONE_FOLDER}
                  onValueChange={(v) => setFolderId(v === NONE_FOLDER ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No folder" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_FOLDER}>No folder</SelectItem>
                    {folders.map((f) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  <Link
                    href="/dashboard/projects"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Projects dashboard
                  </Link>
                  &nbsp;— create or rename folders and team tags.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Tags</Label>
                {allTags.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tags in this team yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {allTags.map((t) => {
                      const on = tagIds.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => toggleTag(t.id)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                            on
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-border bg-background hover:bg-accent',
                          )}
                        >
                          {on && <Check className="h-3.5 w-3.5 text-primary" />}
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: t.color }}
                          />
                          {t.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        <section className="rounded-xl border bg-muted/30 p-6 space-y-3">
          <h2 className="text-base font-semibold">Project identifiers</h2>
          <p className="text-sm text-muted-foreground">
            Read-only. Use these in support tickets or when configuring CI.
          </p>
          <dl className="grid gap-2 text-sm sm:grid-cols-[120px_1fr] sm:items-baseline">
            <dt className="text-muted-foreground">Project ID</dt>
            <dd className="font-mono text-xs break-all">{project.id}</dd>
            <dt className="text-muted-foreground">Slug</dt>
            <dd className="font-mono text-xs break-all">{project.slug}</dd>
            <dt className="text-muted-foreground">Created</dt>
            <dd>{new Date(project.createdAt).toLocaleString()}</dd>
          </dl>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </div>
      </form>

      <MaxRowsCard
        projectId={project.id}
        current={project.maxRowsPerTable ?? 1000}
        onSaved={() => { void refreshProject?.(); }}
      />

      <TransferTeamCard
        projectId={project.id}
        currentTeamId={project.teamId}
        onMoved={() => { void refreshProject?.(); }}
      />

      <DangerZone
        projectId={project.id}
        projectName={project.name}
        onDone={() => router.push('/dashboard/projects')}
      />
    </div>
  );
}

function TransferTeamCard({
  projectId,
  currentTeamId,
  onMoved,
}: {
  projectId: string;
  currentTeamId: string;
  onMoved: () => void;
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [target, setTarget] = useState('');
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    api.teams.list().then(setTeams).catch(() => setTeams([]));
  }, []);

  const others = teams.filter((t) => t.id !== currentTeamId);

  async function move() {
    if (!target) return;
    const dest = teams.find((t) => t.id === target);
    const ok = await confirmDialog({
      title: 'Move project to another team',
      description: `Move this project to "${dest?.name ?? 'the selected team'}"? Team members there will get access; only the current team owner can do this.`,
      confirmText: 'Move project',
    });
    if (!ok) return;
    setMoving(true);
    try {
      await api.projects.moveToTeam(projectId, target);
      toast.success('Project moved to the new team');
      setTarget('');
      onMoved();
    } catch (err: any) {
      toast.error(err.message || 'Failed to move project');
    } finally {
      setMoving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ArrowRightLeft className="h-4 w-4 text-muted-foreground" /> Team
        </h2>
        <p className="text-sm text-muted-foreground">
          Move this project to another team you own. Its data, auth and storage move with it.
        </p>
      </div>
      {others.length === 0 ? (
        <p className="text-sm text-muted-foreground">You have no other team to move this project to.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Select value={target} onValueChange={setTarget} disabled={moving}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Select a team…" />
            </SelectTrigger>
            <SelectContent>
              {others.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="button" variant="outline" onClick={move} disabled={!target || moving}>
            {moving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Move
          </Button>
        </div>
      )}
    </section>
  );
}

function DangerZone({
  projectId,
  projectName,
  onDone,
}: {
  projectId: string;
  projectName: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<null | 'deactivate' | 'delete'>(null);

  async function deactivate() {
    const ok = await confirmDialog({
      title: 'Deactivate project',
      description:
        'The project is frozen — closed to use, but its data is kept. It frees a slot on your plan so you can create another project. You can reactivate it anytime (a free slot is required). If left deactivated, it is permanently deleted after 14 days.',
      confirmText: 'Deactivate',
    });
    if (!ok) return;
    setBusy('deactivate');
    try {
      await api.projects.deactivate(projectId);
      toast.success('Project deactivated');
      onDone();
    } catch (err: any) {
      toast.error(err.message || 'Failed to deactivate project');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Move project to trash',
      description: `Delete "${projectName}"? It stays in trash for 24 hours — the team owner can restore it during that window. After 24 hours it is permanently deleted.`,
      confirmText: 'Move to trash',
      destructive: true,
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await api.projects.delete(projectId);
      toast.success('Project moved to trash');
      onDone();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete project');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-destructive/30 bg-destructive/[0.03] p-6">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-destructive">
          <TriangleAlert className="h-4 w-4" /> Danger zone
        </h2>
        <p className="text-sm text-muted-foreground">
          Freeze this project to free a plan slot, or delete it.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border bg-background p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Deactivate project</p>
          <p className="text-xs text-muted-foreground">
            Freeze it and free a plan slot. Reactivate anytime within 14 days.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={deactivate} disabled={busy !== null} className="shrink-0">
          {busy === 'deactivate' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Power className="mr-2 h-4 w-4" />}
          Deactivate
        </Button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-destructive/40 bg-background p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Delete project</p>
          <p className="text-xs text-muted-foreground">
            Move to trash. Permanently removed after 24 hours.
          </p>
        </div>
        <Button type="button" variant="destructive" onClick={remove} disabled={busy !== null} className="shrink-0">
          {busy === 'delete' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
          Delete
        </Button>
      </div>
    </section>
  );
}

const ROW_LIMIT_OPTIONS = [1000, 10000, 100000];

function MaxRowsCard({
  projectId,
  current,
  onSaved,
}: {
  projectId: string;
  current: number;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(String(current));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(String(current));
  }, [current]);

  async function save(next: string) {
    const n = Number(next);
    setSaving(true);
    try {
      await api.projects.setMaxRowsPerTable(projectId, n);
      toast.success(`Row limit set to ${n.toLocaleString()} per table`);
      onSaved();
    } catch (err: any) {
      // Plan-gated failures come back as a clear "upgrade your plan" message.
      toast.error(err.message || 'Failed to update row limit');
      setValue(String(current));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border bg-card p-6">
      <div>
        <h2 className="text-lg font-semibold">Rows per table</h2>
        <p className="text-sm text-muted-foreground">
          How many rows the Data grid loads per table. Higher limits are available on paid
          plans — Free up to 1,000, Pro up to 10,000, Business up to 100,000.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Select
          value={value}
          onValueChange={(v) => {
            setValue(v);
            void save(v);
          }}
          disabled={saving}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROW_LIMIT_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n.toLocaleString()} rows
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
    </section>
  );
}
