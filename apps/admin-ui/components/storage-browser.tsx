'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useLiveProjectRefresh } from '@/lib/use-live-refresh';
import { getAccessToken } from '@/lib/auth';
import type { StorageBucket, StorageObject } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File,
  Folder,
  FolderInput,
  FolderPlus,
  Globe,
  HardDrive,
  Link2,
  Lock,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';

// ── helpers ──────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function copyToClipboard(text: string, label = 'URL') {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

// ── main component ───────────────────────────────────────

export function StorageBrowser({ projectId }: { projectId: string }) {
  const [activeBucket, setActiveBucket] = useState<string | null>(null);

  if (activeBucket) {
    return (
      <BucketDetail
        projectId={projectId}
        bucketName={activeBucket}
        onBack={() => setActiveBucket(null)}
      />
    );
  }

  return (
    <BucketList
      projectId={projectId}
      onSelect={(name) => setActiveBucket(name)}
    />
  );
}

// ── Bucket list ──────────────────────────────────────────

function BucketList({
  projectId,
  onSelect,
}: {
  projectId: string;
  onSelect: (name: string) => void;
}) {
  const [buckets, setBuckets] = useState<StorageBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPublic, setNewPublic] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBuckets(await api.storage.listBuckets(projectId));
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useLiveProjectRefresh(projectId, ['storage.'], load);

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      await api.storage.createBucket(projectId, newName.trim(), newPublic);
      toast.success(`Bucket "${newName.trim()}" created`);
      setNewName('');
      setNewPublic(false);
      setCreating(false);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDelete(e: React.MouseEvent, name: string) {
    e.stopPropagation();
    if (!(await confirmDialog({ title: 'Delete bucket', description: `Delete bucket "${name}" and all its contents?`, destructive: true }))) return;
    try {
      await api.storage.deleteBucket(projectId, name);
      toast.success(`Bucket "${name}" deleted`);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Storage</h2>
          <p className="text-sm text-muted-foreground">
            Manage file buckets for this project
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New bucket
          </Button>
        </div>
      </div>

      {creating && (
        <div className="flex items-end gap-3 rounded-md border bg-muted/30 p-4">
          <div className="flex-1 space-y-1.5">
            <label className="text-xs font-medium">Bucket name</label>
            <Input
              placeholder="e.g. avatars, uploads, assets"
              value={newName}
              onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
          </div>
          <label className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={newPublic}
              onChange={(e) => setNewPublic(e.target.checked)}
              className="h-3.5 w-3.5 rounded"
            />
            Public
          </label>
          <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName(''); }}>
            Cancel
          </Button>
        </div>
      )}

      <div className="rounded-md border">
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
          <span className="flex-1">Bucket</span>
          <span className="w-20 text-center">Access</span>
          <span className="w-20 text-right">Objects</span>
          <span className="w-24 text-right">Size</span>
          <span className="w-40 text-right">Created</span>
          <span className="w-10" />
        </div>

        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : buckets.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
            <HardDrive className="h-8 w-8" />
            <p className="text-sm">No buckets yet</p>
            <p className="text-xs">Create your first bucket to start uploading files</p>
            {!creating && (
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setCreating(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New bucket
              </Button>
            )}
          </div>
        ) : (
          buckets.map((bucket) => (
            <div
              key={bucket.id}
              onClick={() => onSelect(bucket.name)}
              className="flex items-center gap-3 border-b px-4 py-3 text-sm hover:bg-muted/30 transition-colors cursor-pointer group"
            >
              <div className="flex flex-1 items-center gap-2.5">
                <HardDrive className="h-4 w-4 text-primary" />
                <span className="font-medium">{bucket.name}</span>
              </div>

              <div className="w-20 flex justify-center">
                {bucket.public ? (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <Globe className="h-3 w-3" /> Public
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Lock className="h-3 w-3" /> Private
                  </Badge>
                )}
              </div>

              <span className="w-20 text-right text-muted-foreground">
                {bucket.objectCount}
              </span>
              <span className="w-24 text-right text-muted-foreground">
                {formatBytes(bucket.totalSize)}
              </span>
              <span className="w-40 text-right text-muted-foreground">
                {formatDate(bucket.createdAt)}
              </span>

              <Button
                variant="ghost"
                size="icon"
                className="w-10 h-7 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                onClick={(e) => handleDelete(e, bucket.name)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Bucket detail (tabs: Files / Settings) ───────────────

function BucketDetail({
  projectId,
  bucketName,
  onBack,
}: {
  projectId: string;
  bucketName: string;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<'files' | 'settings'>('files');
  const [bucketInfo, setBucketInfo] = useState<StorageBucket | null>(null);

  const loadBucketInfo = useCallback(async () => {
    try {
      const buckets = await api.storage.listBuckets(projectId);
      const found = buckets.find((b: StorageBucket) => b.name === bucketName);
      if (found) setBucketInfo(found);
    } catch {}
  }, [projectId, bucketName]);

  useEffect(() => { loadBucketInfo(); }, [loadBucketInfo]);

  return (
    <div className="w-full min-w-0 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Buckets
          </Button>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{bucketName}</h2>
            {bucketInfo && (
              bucketInfo.public ? (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <Globe className="h-3 w-3" /> Public
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Lock className="h-3 w-3" /> Private
                </Badge>
              )
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        <button
          onClick={() => setTab('files')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'files'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Files
        </button>
        <button
          onClick={() => setTab('settings')}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'settings'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Settings className="h-3.5 w-3.5" />
          Settings
        </button>
      </div>

      {tab === 'files' ? (
        <ObjectBrowser
          projectId={projectId}
          bucketName={bucketName}
          bucketInfo={bucketInfo}
        />
      ) : (
        <BucketSettings
          projectId={projectId}
          bucketName={bucketName}
          bucketInfo={bucketInfo}
          onUpdate={loadBucketInfo}
        />
      )}
    </div>
  );
}

// ── Bucket settings ──────────────────────────────────────

function BucketSettings({
  projectId,
  bucketName,
  bucketInfo,
  onUpdate,
}: {
  projectId: string;
  bucketName: string;
  bucketInfo: StorageBucket | null;
  onUpdate: () => void;
}) {
  const [toggling, setToggling] = useState(false);

  async function handleTogglePublic() {
    if (!bucketInfo) return;
    setToggling(true);
    try {
      await api.storage.updateBucket(projectId, bucketName, !bucketInfo.public);
      toast.success(`Bucket is now ${!bucketInfo.public ? 'public' : 'private'}`);
      onUpdate();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setToggling(false);
    }
  }

  if (!bucketInfo) {
    return (
      <div className="flex h-32 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* General info */}
      <section className="rounded-md border">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">General</h3>
        </div>
        <div className="divide-y">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Bucket name</span>
            <span className="text-sm font-medium">{bucketName}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Objects</span>
            <span className="text-sm font-medium">{bucketInfo.objectCount}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Total size</span>
            <span className="text-sm font-medium">{formatBytes(bucketInfo.totalSize)}</span>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Created</span>
            <span className="text-sm font-medium">{formatDate(bucketInfo.createdAt)}</span>
          </div>
        </div>
      </section>

      {/* Access */}
      <section className="rounded-md border">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Access Control</h3>
        </div>
        <div className="px-4 py-4 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium">
                {bucketInfo.public ? 'Public access' : 'Private access'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {bucketInfo.public
                  ? 'Anyone with the URL can read files in this bucket.'
                  : 'Files require a signed URL or API key to access.'}
              </p>
            </div>
            <button
              onClick={handleTogglePublic}
              disabled={toggling}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                bucketInfo.public ? 'bg-primary' : 'bg-muted'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform ${
                  bucketInfo.public ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {bucketInfo.public && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs dark:border-amber-800 dark:bg-amber-950">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                Public bucket
              </p>
              <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                All files in this bucket are publicly readable. Do not store sensitive data.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Danger zone */}
      <section className="rounded-md border border-red-200 dark:border-red-800">
        <div className="border-b border-red-200 dark:border-red-800 px-4 py-3">
          <h3 className="text-sm font-semibold text-red-600 dark:text-red-400">Danger Zone</h3>
        </div>
        <div className="flex items-center justify-between px-4 py-4">
          <div>
            <p className="text-sm font-medium">Delete bucket</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Permanently delete this bucket and all its files.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={async () => {
              if (!(await confirmDialog({ title: 'Delete bucket', description: `Delete bucket "${bucketName}" and all its contents? This cannot be undone.`, destructive: true }))) return;
              try {
                await api.storage.deleteBucket(projectId, bucketName);
                toast.success(`Bucket "${bucketName}" deleted`);
                window.location.reload();
              } catch (err: any) {
                toast.error(err.message);
              }
            }}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete bucket
          </Button>
        </div>
      </section>
    </div>
  );
}

// ── Object browser inside a bucket ───────────────────────

function ObjectBrowser({
  projectId,
  bucketName,
  bucketInfo,
}: {
  projectId: string;
  bucketName: string;
  bucketInfo: StorageBucket | null;
}) {
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [prefix, setPrefix] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [urlLoading, setUrlLoading] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [moveSources, setMoveSources] = useState<string[] | null>(null);
  const [moveDest, setMoveDest] = useState('');
  const [moving, setMoving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const isPublic = bucketInfo?.public === true;

  const load = useCallback(async () => {
    setLoading(true);
    setSelected(new Set());
    try {
      setObjects(await api.storage.listObjects(projectId, bucketName, prefix));
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, bucketName, prefix]);

  useEffect(() => { load(); }, [load]);
  useLiveProjectRefresh(projectId, ['storage.'], load);

  const breadcrumbs = prefix ? prefix.split('/').filter(Boolean) : [];
  const folders = objects.filter((o) => o.prefix);
  const files = objects.filter((o) => !o.prefix && o.name);

  async function handleUpload(fileList: FileList | null) {
    if (!fileList?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        await api.storage.upload(projectId, bucketName, prefix + file.name, file);
        toast.success(`Uploaded ${file.name}`);
      }
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // Upload a whole local folder, preserving its structure. Files carry a
  // webkitRelativePath like "myfolder/sub/file.png" — uploaded under the
  // current prefix so the same folder tree is recreated. On name clashes we
  // ask once whether to overwrite.
  async function handleUploadFolder(fileList: FileList | null) {
    const all = Array.from(fileList ?? []);
    if (!all.length) return;
    setUploading(true);
    try {
      const targets = all.map((file) => ({
        file,
        path: prefix + ((file as any).webkitRelativePath || file.name),
      }));

      let toUpload = targets;
      try {
        const { existing } = await api.storage.findExisting(
          projectId,
          bucketName,
          targets.map((t) => t.path),
        );
        if (existing.length > 0) {
          const overwrite = await confirmDialog({
            title: 'Some files already exist',
            description: `${existing.length} of ${targets.length} file(s) already exist in this location. Overwrite them?`,
            confirmText: 'Overwrite',
            cancelText: 'Skip existing',
          });
          if (!overwrite) {
            const existingSet = new Set(existing);
            toUpload = targets.filter((t) => !existingSet.has(t.path.replace(/^\/+/, '')));
          }
        }
      } catch {
        /* existence check is best-effort; fall back to uploading all */
      }

      if (toUpload.length === 0) {
        toast.message('Nothing to upload — all files were skipped.');
        return;
      }

      let done = 0;
      for (const { file, path } of toUpload) {
        await api.storage.upload(projectId, bucketName, path, file);
        done++;
      }
      toast.success(`Uploaded ${done} file(s) from the folder`);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setUploading(false);
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    try {
      await api.storage.createFolder(projectId, bucketName, prefix + name);
      toast.success(`Folder "${name}" created`);
      setNewFolderName('');
      setCreatingFolder(false);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleMove() {
    if (!moveSources?.length) return;
    setMoving(true);
    try {
      const { moved } = await api.storage.moveObjects(projectId, bucketName, moveSources, moveDest);
      toast.success(`Moved ${moved} item(s)`);
      setMoveSources(null);
      setMoveDest('');
      setSelected(new Set());
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setMoving(false);
    }
  }

  async function handleCopyPublicLink(path: string, label: string) {
    try {
      const { public: pub, url } = await api.storage.publicUrl(projectId, bucketName, path);
      if (!pub || !url) {
        toast.error('Bucket is private — make it public to get a shareable link.');
        return;
      }
      copyToClipboard(url);
      toast.success(`Public link copied (${label})`);
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDownload(objectName: string) {
    try {
      const res = await fetch(
        `/api/proxy/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}/objects/download?path=${encodeURIComponent(objectName)}`,
        { headers: { Authorization: `Bearer ${getAccessToken()}` } },
      );
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = objectName.split('/').pop() || objectName;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleCopyUrl(objectName: string) {
    setUrlLoading(objectName);
    try {
      // Public bucket → permanent public URL; private → temporary signed URL.
      if (isPublic) {
        const { url } = await api.storage.publicUrl(projectId, bucketName, objectName);
        if (url) {
          copyToClipboard(url);
          toast.success('Public link copied');
          return;
        }
      }
      const { url } = await api.storage.downloadUrl(projectId, bucketName, objectName);
      copyToClipboard(url);
      toast.success('Temporary link copied');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setUrlLoading(null);
    }
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    if (!(await confirmDialog({ title: 'Delete items', description: `Delete ${selected.size} item(s)?`, destructive: true }))) return;
    try {
      await api.storage.deleteObjects(projectId, bucketName, Array.from(selected));
      toast.success(`Deleted ${selected.size} item(s)`);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(selected.size === files.length ? new Set() : new Set(files.map((f) => f.name)));
  }

  return (
    <div className="w-full min-w-0 space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        {selected.size > 0 && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setMoveSources(Array.from(selected)); setMoveDest(''); }}
            >
              <FolderInput className="mr-1.5 h-3.5 w-3.5" />
              Move ({selected.size})
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteSelected}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete ({selected.size})
            </Button>
          </>
        )}
        {isPublic && (
          <Button
            variant="outline"
            size="sm"
            title="Copy this bucket's public base URL"
            onClick={() => handleCopyPublicLink('', 'bucket')}
          >
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            Public link
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => setCreatingFolder((v) => !v)}>
          <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
          New folder
        </Button>
        <Button variant="outline" size="sm" onClick={() => folderInputRef.current?.click()} disabled={uploading}>
          <Folder className="mr-1.5 h-3.5 w-3.5" />
          Upload folder
        </Button>
        <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => handleUpload(e.target.files)}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          className="hidden"
          // Non-standard but widely supported directory picker attributes.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => handleUploadFolder(e.target.files)}
        />
      </div>

      {creatingFolder && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
          <FolderPlus className="h-4 w-4 text-blue-500" />
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); }
            }}
            placeholder="Folder name"
            className="h-8 flex-1 rounded border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button size="sm" onClick={handleCreateFolder} disabled={!newFolderName.trim()}>
            Create
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setCreatingFolder(false); setNewFolderName(''); }}>
            Cancel
          </Button>
        </div>
      )}

      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <button
          onClick={() => setPrefix('')}
          className="flex items-center gap-1 font-medium text-primary hover:underline"
        >
          <HardDrive className="h-3.5 w-3.5" />
          {bucketName}
        </button>
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button
              onClick={() => setPrefix(breadcrumbs.slice(0, i + 1).join('/') + '/')}
              className={i === breadcrumbs.length - 1 ? 'font-medium' : 'text-primary hover:underline'}
            >
              {crumb}
            </button>
          </span>
        ))}
      </div>

      {/* File list */}
      <div className="rounded-md border">
        <div className="flex items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded"
            checked={files.length > 0 && selected.size === files.length}
            onChange={toggleSelectAll}
          />
          <span className="flex-1">Name</span>
          <span className="w-24 text-right">Size</span>
          <span className="w-44 text-right">Last Modified</span>
          <span className="w-28" />
        </div>

        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : folders.length === 0 && files.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Folder className="h-8 w-8" />
            <p className="text-sm">This bucket is empty</p>
            <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Upload files
            </Button>
          </div>
        ) : (
          <div>
            {folders.map((folder) => (
              <div
                key={folder.prefix}
                className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-sm hover:bg-muted/30 transition-colors"
              >
                <span className="h-3.5 w-3.5" />
                <button
                  onClick={() => setPrefix(folder.prefix!)}
                  className="flex flex-1 items-center gap-3 text-left"
                >
                  <Folder className="h-4 w-4 text-blue-500" />
                  <span className="flex-1 font-medium">
                    {folder.prefix!.replace(prefix, '').replace(/\/$/, '')}
                  </span>
                </button>
                <span className="w-24 text-right text-muted-foreground">—</span>
                <span className="w-44 text-right text-muted-foreground">—</span>
                <div className="flex w-28 justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Move folder"
                    onClick={() => { setMoveSources([folder.prefix!]); setMoveDest(''); }}
                  >
                    <FolderInput className="h-3.5 w-3.5" />
                  </Button>
                  {isPublic && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Copy folder public link"
                      onClick={() => handleCopyPublicLink(folder.prefix!, 'folder')}
                    >
                      <Globe className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {files.map((file) => {
              const fileName = file.name.replace(prefix, '');
              const isChecked = selected.has(file.name);
              return (
                <div
                  key={file.name}
                  className={`flex items-center gap-3 border-b px-4 py-2.5 text-sm transition-colors ${isChecked ? 'bg-primary/5' : 'hover:bg-muted/30'}`}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded"
                    checked={isChecked}
                    onChange={() => toggleSelect(file.name)}
                  />
                  <FileIcon name={fileName} />
                  <span className="flex-1 truncate">{fileName}</span>
                  <span className="w-24 text-right text-muted-foreground">{formatBytes(file.size)}</span>
                  <span className="w-44 text-right text-muted-foreground">{formatDate(file.lastModified)}</span>
                  <div className="flex w-28 justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Copy URL"
                      disabled={urlLoading === file.name}
                      onClick={() => handleCopyUrl(file.name)}
                    >
                      {urlLoading === file.name ? (
                        <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
                      ) : (
                        <Link2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Download" onClick={() => handleDownload(file.name)}>
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: 'Delete file', description: `Delete ${fileName}?`, destructive: true }))) return;
                        try {
                          await api.storage.deleteObjects(projectId, bucketName, [file.name]);
                          toast.success(`Deleted ${fileName}`);
                          await load();
                        } catch (err: any) {
                          toast.error(err.message);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {moveSources && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !moving && setMoveSources(null)}>
          <div className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">Move {moveSources.length} item(s)</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose a destination folder in this bucket. Folders move with their contents.
            </p>
            <div className="mt-3 space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setMoveDest('')}
                  className={`rounded-md border px-2 py-1 text-xs ${moveDest === '' ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}
                >
                  / (root)
                </button>
                {folders
                  .filter((f) => !moveSources.includes(f.prefix!))
                  .map((f) => (
                    <button
                      key={f.prefix}
                      type="button"
                      onClick={() => setMoveDest(f.prefix!)}
                      className={`rounded-md border px-2 py-1 text-xs ${moveDest === f.prefix ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}
                    >
                      {f.prefix!.replace(prefix, '').replace(/\/$/, '')}
                    </button>
                  ))}
              </div>
              <input
                value={moveDest}
                onChange={(e) => setMoveDest(e.target.value)}
                placeholder="or type a folder path (blank = root)"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMoveSources(null)} disabled={moving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleMove} disabled={moving}>
                {moving ? 'Moving…' : 'Move here'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
  const codeExts = ['ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'py', 'go', 'rs'];

  let color = 'text-muted-foreground';
  if (imageExts.includes(ext)) color = 'text-green-500';
  else if (codeExts.includes(ext)) color = 'text-orange-500';
  else if (ext === 'pdf') color = 'text-red-500';

  return <File className={`h-4 w-4 ${color}`} />;
}
