'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project, ProjectFolder, ProjectTag } from '@/lib/types';
import { useProject } from '@/contexts/project-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ArrowLeft, Check, Loader2 } from 'lucide-react';

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
            Name, description, folder, and tags. Database connection strings stay on the
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

      <Separator />

      <p className="text-center text-xs text-muted-foreground">
        To move this project to another team, use <strong>Overview</strong> (danger zone) or
        team settings.
      </p>
    </div>
  );
}
