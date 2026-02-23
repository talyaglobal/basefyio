'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import type { StorageBucket, StorageObject } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  ChevronRight,
  Download,
  File,
  Folder,
  Globe,
  HardDrive,
  Lock,
  Plus,
  RefreshCw,
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

// ── main component ───────────────────────────────────────

export function StorageBrowser({ projectId }: { projectId: string }) {
  const [activeBucket, setActiveBucket] = useState<string | null>(null);

  if (activeBucket) {
    return (
      <ObjectBrowser
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

  async function handleDelete(name: string) {
    if (!confirm(`Delete bucket "${name}" and all its contents?`)) return;
    try {
      await api.storage.deleteBucket(projectId, name);
      toast.success(`Bucket "${name}" deleted`);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleTogglePublic(name: string, current: boolean) {
    try {
      await api.storage.updateBucket(projectId, name, !current);
      toast.success(`Bucket "${name}" is now ${!current ? 'public' : 'private'}`);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  return (
    <div className="space-y-4">
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

      {/* Create bucket form */}
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

      {/* Bucket table */}
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
              className="flex items-center gap-3 border-b px-4 py-3 text-sm hover:bg-muted/30 transition-colors group"
            >
              <button
                className="flex flex-1 items-center gap-2.5 text-left"
                onClick={() => onSelect(bucket.name)}
              >
                <HardDrive className="h-4 w-4 text-primary" />
                <span className="font-medium">{bucket.name}</span>
              </button>

              <div className="w-20 flex justify-center">
                <button
                  onClick={() => handleTogglePublic(bucket.name, bucket.public)}
                  title={bucket.public ? 'Click to make private' : 'Click to make public'}
                >
                  {bucket.public ? (
                    <Badge variant="secondary" className="gap-1 text-[10px]">
                      <Globe className="h-3 w-3" /> Public
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      <Lock className="h-3 w-3" /> Private
                    </Badge>
                  )}
                </button>
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
                onClick={() => handleDelete(bucket.name)}
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

// ── Object browser inside a bucket ───────────────────────

function ObjectBrowser({
  projectId,
  bucketName,
  onBack,
}: {
  projectId: string;
  bucketName: string;
  onBack: () => void;
}) {
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [prefix, setPrefix] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} item(s)?`)) return;
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
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Buckets
          </Button>
          <div>
            <h2 className="text-lg font-semibold">{bucketName}</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {selected.size > 0 && (
            <Button variant="destructive" size="sm" onClick={handleDeleteSelected}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete ({selected.size})
            </Button>
          )}
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
        </div>
      </div>

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
          <span className="w-20" />
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
              <button
                key={folder.prefix}
                onClick={() => setPrefix(folder.prefix!)}
                className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-sm hover:bg-muted/30 transition-colors"
              >
                <span className="h-3.5 w-3.5" />
                <Folder className="h-4 w-4 text-blue-500" />
                <span className="flex-1 text-left font-medium">
                  {folder.prefix!.replace(prefix, '').replace(/\/$/, '')}
                </span>
                <span className="w-24 text-right text-muted-foreground">—</span>
                <span className="w-44 text-right text-muted-foreground">—</span>
                <span className="w-20" />
              </button>
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
                  <div className="flex w-20 justify-end gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Download" onClick={() => handleDownload(file.name)}>
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      title="Delete"
                      onClick={async () => {
                        if (!confirm(`Delete ${fileName}?`)) return;
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
