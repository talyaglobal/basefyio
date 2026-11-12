'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useLiveProjectRefresh } from '@/lib/use-live-refresh';
import { getAccessToken } from '@/lib/auth';
import type { StorageBucket, StorageObject, StoragePolicyMode, UploadProgress } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Download,
  Eye,
  File,
  Folder,
  FolderInput,
  FolderPlus,
  Globe,
  HardDrive,
  LayoutGrid,
  Link2,
  List,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

// ── helpers ──────────────────────────────────────────────

/** Files at or above this size go up in chunks through a resumable session. */
const RESUMABLE_THRESHOLD = 64 * 1024 * 1024;
/** Largest file the preview pane loads into the browser. */
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
/** Text previews show at most this much. */
const TEXT_PREVIEW_BYTES = 200 * 1024;

type PolicyChoice = 'default' | StoragePolicyMode;

const POLICY_LABEL: Record<PolicyChoice, string> = {
  default: 'Default — signed-in users, signed URLs, service key',
  'public-read': 'Anyone with the public anon key can read',
  'authenticated-read': 'Signed-in users only (explicit)',
  'owner-only': 'Owner only',
};

const POLICY_HELP: Record<PolicyChoice, string> = {
  default:
    "Files are read by signed-in users of your app, through signed URLs and with the service key. The public anon key on its own can neither read nor write. Writes need a signed-in user or the service key.",
  'public-read':
    'Opens reads to the public anon key, which ships inside your app — anyone who has it can read every file here. Writes still need a signed-in user or the service key.',
  'authenticated-read': 'Reads need a signed-in user of your app. The public key on its own is refused.',
  'owner-only': 'Files are readable and deletable only by the signed-in user who uploaded them.',
};

type SortKey = 'name' | 'size' | 'lastModified';
type ViewMode = 'list' | 'grid';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif', 'bmp'];
const TEXT_EXTS = ['txt', 'md', 'csv', 'json', 'log', 'xml', 'yml', 'yaml', 'ts', 'tsx', 'js', 'jsx', 'css', 'sql', 'py', 'go', 'rs', 'sh', 'env', 'ini', 'toml'];

function extOf(name: string): string {
  const base = name.split('/').pop() || '';
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
}

function previewKind(name: string): 'image' | 'pdf' | 'text' | 'video' | 'audio' | null {
  const ext = extOf(name);
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXTS.includes(ext) || ext === 'html') return 'text';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
  return null;
}

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

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

/** Suggest a free name by appending _2, _3, … (keeping any file extension). */
function computeFreeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  let i = 2;
  while (taken.has(`${base}_${i}${ext}`)) i++;
  return `${base}_${i}${ext}`;
}

/** What the API accepts for a bucket name: lowercase letters, digits and hyphens, 3–63, no hyphen at either end. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The name a typed value becomes, so the user sees the change instead of it happening silently. */
function suggestBucketName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The authenticated bytes of one object, as a Blob. */
async function fetchObject(projectId: string, bucketName: string, objectName: string): Promise<Blob> {
  const res = await fetch(
    `/api/proxy/projects/${projectId}/storage/buckets/${encodeURIComponent(bucketName)}/objects/download?path=${encodeURIComponent(objectName)}`,
    { headers: { Authorization: `Bearer ${getAccessToken()}` } },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Download failed: ${res.status}`);
  }
  return res.blob();
}

// ── main component ───────────────────────────────────────

/**
 * Buckets → files. The open bucket and folder live in the page address
 * (`?bucket=…&path=…`), so a location can be shared and the back button works.
 */
export function StorageBrowser({ projectId }: { projectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeBucket = searchParams.get('bucket');
  const prefix = searchParams.get('path') ?? '';

  const go = useCallback(
    (bucket: string | null, path = '') => {
      const q = new URLSearchParams();
      if (bucket) q.set('bucket', bucket);
      if (bucket && path) q.set('path', path);
      const qs = q.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  if (activeBucket) {
    return (
      <BucketDetail
        projectId={projectId}
        bucketName={activeBucket}
        prefix={prefix}
        onPrefixChange={(p) => go(activeBucket, p)}
        onBack={() => go(null)}
      />
    );
  }

  return <BucketList projectId={projectId} onSelect={(name) => go(name)} />;
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

  const finalName = suggestBucketName(newName);
  const nameChanged = newName.trim() !== '' && finalName !== newName.trim();
  const nameValid = BUCKET_NAME_RE.test(finalName);

  async function handleCreate() {
    if (!nameValid) return;
    if (newPublic) {
      const ok = await confirmDialog({
        title: 'Create a public bucket?',
        description: `Every file in "${finalName}" will be readable by anyone who has its link, without signing in. Do not store private or sensitive files in a public bucket.`,
        confirmText: 'Create public bucket',
      });
      if (!ok) return;
    }
    try {
      await api.storage.createBucket(projectId, finalName, newPublic);
      toast.success(`Bucket "${finalName}" created`);
      setNewName('');
      setNewPublic(false);
      setCreating(false);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDelete(e: React.MouseEvent, bucket: StorageBucket) {
    e.stopPropagation();
    const files = bucket.objectCount;
    const ok = await confirmDialog({
      title: 'Delete bucket',
      description:
        files > 0
          ? `Delete bucket "${bucket.name}" and all ${files} file(s) in it? This cannot be undone.`
          : `Delete the empty bucket "${bucket.name}"?`,
      confirmText: 'Delete bucket',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.storage.deleteBucket(projectId, bucket.name);
      toast.success(`Bucket "${bucket.name}" deleted`);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Storage</h1>
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
        <div className="space-y-2 rounded-md border bg-muted/30 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1 space-y-1.5">
              <label htmlFor="new-bucket-name" className="text-xs font-medium">Bucket name</label>
              <Input
                id="new-bucket-name"
                placeholder="e.g. avatars, uploads, assets"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                aria-describedby="new-bucket-name-hint"
                autoFocus
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={newPublic}
                onChange={(e) => setNewPublic(e.target.checked)}
                className="h-3.5 w-3.5 rounded"
              />
              Public
            </label>
            <Button size="sm" onClick={handleCreate} disabled={!nameValid}>
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setCreating(false); setNewName(''); }}>
              Cancel
            </Button>
          </div>
          <p id="new-bucket-name-hint" className="text-xs text-muted-foreground" aria-live="polite">
            {newName.trim() === ''
              ? 'Lowercase letters, numbers and hyphens; 3–63 characters.'
              : !nameValid
                ? 'A bucket name needs 3–63 lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.'
                : nameChanged
                  ? <>Bucket names use only lowercase letters, numbers and hyphens, so it will be created as <code className="rounded bg-muted px-1">{finalName}</code>.</>
                  : 'Lowercase letters, numbers and hyphens; 3–63 characters.'}
          </p>
          {newPublic && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Files in a public bucket can be read by anyone with their link. Keep private files in a private bucket.
            </p>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <div className="flex min-w-[40rem] items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
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
              className="group flex min-w-[40rem] items-center gap-3 border-b px-4 py-3 text-sm transition-colors hover:bg-muted/30"
            >
              <button
                type="button"
                onClick={() => onSelect(bucket.name)}
                className="flex flex-1 items-center gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HardDrive className="h-4 w-4 text-primary" aria-hidden="true" />
                <span className="font-medium">{bucket.name}</span>
              </button>

              <div className="flex w-20 justify-center">
                {bucket.public ? (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <Globe className="h-3 w-3" aria-hidden="true" /> Public
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Lock className="h-3 w-3" aria-hidden="true" /> Private
                  </Badge>
                )}
              </div>

              <span className="w-20 text-right text-muted-foreground">{bucket.objectCount}</span>
              <span className="w-24 text-right text-muted-foreground">{formatBytes(bucket.totalSize)}</span>
              <span className="w-40 text-right text-muted-foreground">{formatDate(bucket.createdAt)}</span>

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-10 text-destructive opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                onClick={(e) => handleDelete(e, bucket)}
                aria-label={`Delete bucket ${bucket.name}`}
                title={`Delete bucket ${bucket.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
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
  prefix,
  onPrefixChange,
  onBack,
}: {
  projectId: string;
  bucketName: string;
  prefix: string;
  onPrefixChange: (prefix: string) => void;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<'files' | 'settings'>('files');
  const [bucketInfo, setBucketInfo] = useState<StorageBucket | null>(null);
  const [missing, setMissing] = useState(false);

  const loadBucketInfo = useCallback(async () => {
    try {
      const buckets = await api.storage.listBuckets(projectId);
      const found = buckets.find((b: StorageBucket) => b.name === bucketName);
      setBucketInfo(found ?? null);
      setMissing(!found);
    } catch {}
  }, [projectId, bucketName]);

  useEffect(() => { loadBucketInfo(); }, [loadBucketInfo]);
  // Counters on the Settings tab follow uploads and deletes, here or elsewhere.
  useLiveProjectRefresh(projectId, ['storage.'], loadBucketInfo);
  useEffect(() => {
    if (tab === 'settings') void loadBucketInfo();
  }, [tab, loadBucketInfo]);

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
            <h1 className="text-lg font-semibold">{bucketName}</h1>
            {bucketInfo && (
              bucketInfo.public ? (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <Globe className="h-3 w-3" aria-hidden="true" /> Public
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-[10px]">
                  <Lock className="h-3 w-3" aria-hidden="true" /> Private
                </Badge>
              )
            )}
          </div>
        </div>
      </div>

      {missing && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Bucket &quot;{bucketName}&quot; does not exist in this project.
        </p>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'files'}
          onClick={() => setTab('files')}
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'files'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          Files
        </button>
        <button
          role="tab"
          aria-selected={tab === 'settings'}
          onClick={() => setTab('settings')}
          className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            tab === 'settings'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          Settings
        </button>
      </div>

      {tab === 'files' ? (
        <ObjectBrowser
          projectId={projectId}
          bucketName={bucketName}
          bucketInfo={bucketInfo}
          prefix={prefix}
          onPrefixChange={onPrefixChange}
          onChanged={loadBucketInfo}
        />
      ) : (
        <BucketSettings
          projectId={projectId}
          bucketName={bucketName}
          bucketInfo={bucketInfo}
          onUpdate={loadBucketInfo}
          onDeleted={onBack}
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
  onDeleted,
}: {
  projectId: string;
  bucketName: string;
  bucketInfo: StorageBucket | null;
  onUpdate: () => void;
  onDeleted: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [policyMode, setPolicyMode] = useState<PolicyChoice>('default');
  const [policySaving, setPolicySaving] = useState(false);
  const [maxMb, setMaxMb] = useState('');
  const [types, setTypes] = useState('');
  const [limitsSaving, setLimitsSaving] = useState(false);

  // The bucket-wide rule (prefix ''). Prefix rules are set through the API.
  useEffect(() => {
    let cancelled = false;
    api.storage
      .getPolicies(projectId)
      .then((rows) => {
        if (cancelled) return;
        const row = rows.find((r) => r.bucket === bucketName && r.pathPrefix === '');
        setPolicyMode(row ? row.mode : 'default');
      })
      .catch(() => {
        /* rules are optional; keep showing the default */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, bucketName]);

  useEffect(() => {
    if (!bucketInfo) return;
    setMaxMb(bucketInfo.fileSizeLimit ? String(Math.round((bucketInfo.fileSizeLimit / (1024 * 1024)) * 100) / 100) : '');
    setTypes((bucketInfo.allowedMimeTypes ?? []).join(', '));
  }, [bucketInfo]);

  async function handleVisibility(makePublic: boolean) {
    if (!bucketInfo || makePublic === bucketInfo.public) return;
    const ok = await confirmDialog(
      makePublic
        ? {
            title: 'Make this bucket public?',
            description: `Every file in "${bucketName}" — including the ones already there — becomes readable by anyone who has its link, without signing in. Do this only for files meant to be public, such as images on your website.`,
            confirmText: 'Make public',
            destructive: true,
          }
        : {
            title: 'Make this bucket private?',
            description: `Public links to files in "${bucketName}" stop working. Your app then reads them as a signed-in user or through signed URLs.`,
            confirmText: 'Make private',
          },
    );
    if (!ok) return;
    setToggling(true);
    try {
      await api.storage.updateBucket(projectId, bucketName, makePublic);
      toast.success(`Bucket is now ${makePublic ? 'public' : 'private'}`);
      onUpdate();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setToggling(false);
    }
  }

  async function handlePolicyChange(next: PolicyChoice) {
    if (next === 'public-read') {
      const ok = await confirmDialog({
        title: 'Open reads to the public key?',
        description:
          'Anyone who has your public anon key — which ships inside your app — will be able to read every file in this bucket.',
        confirmText: 'Open reads',
        destructive: true,
      });
      if (!ok) return;
    }
    setPolicySaving(true);
    try {
      if (next === 'default') await api.storage.removePolicy(projectId, bucketName);
      else await api.storage.setPolicy(projectId, bucketName, next);
      setPolicyMode(next);
      toast.success(next === 'default' ? 'Access rule removed' : `Access rule set: ${POLICY_LABEL[next]}`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setPolicySaving(false);
    }
  }

  async function handleSaveLimits() {
    const mb = maxMb.trim();
    let fileSizeLimit: number | null = null;
    if (mb) {
      const n = Number(mb);
      if (!Number.isFinite(n) || n <= 0) {
        toast.error('Largest file must be a positive number of megabytes, or empty for no bucket limit.');
        return;
      }
      fileSizeLimit = Math.round(n * 1024 * 1024);
    }
    const allowedMimeTypes = types
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    setLimitsSaving(true);
    try {
      await api.storage.updateBucketLimits(projectId, bucketName, { fileSizeLimit, allowedMimeTypes });
      toast.success('Upload limits saved');
      onUpdate();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLimitsSaving(false);
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
    <div className="max-w-2xl space-y-6">
      {/* General info */}
      <section className="rounded-md border">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">General</h2>
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
          <h2 className="text-sm font-semibold">Access Control</h2>
        </div>
        <div className="space-y-4 px-4 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p id="bucket-public-label" className="text-sm font-medium">Public bucket</p>
              <p id="bucket-public-help" className="mt-0.5 text-xs text-muted-foreground">
                {bucketInfo.public
                  ? 'On: anyone with a file’s link can read it, without signing in.'
                  : 'Off: files are read by signed-in users of your app, through signed URLs, or with the service key.'}
              </p>
            </div>
            <Switch
              checked={bucketInfo.public}
              disabled={toggling}
              onCheckedChange={(next) => handleVisibility(next)}
              aria-labelledby="bucket-public-label"
              aria-describedby="bucket-public-help"
            />
          </div>

          {bucketInfo.public && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs dark:border-amber-800 dark:bg-amber-950">
              <p className="font-medium text-amber-800 dark:text-amber-200">Public bucket</p>
              <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                All files in this bucket are publicly readable. Do not store sensitive data.
              </p>
            </div>
          )}

          {/* Access rule for API-key callers */}
          <div className="border-t pt-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <label htmlFor="bucket-access-rule" className="text-sm font-medium">Access rule for API keys</label>
                <p className="mt-0.5 text-xs text-muted-foreground">{POLICY_HELP[policyMode]}</p>
              </div>
              <select
                id="bucket-access-rule"
                value={policyMode}
                disabled={policySaving || bucketInfo.public}
                onChange={(e) => handlePolicyChange(e.target.value as PolicyChoice)}
                className="h-8 shrink-0 rounded-md border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                <option value="default">{POLICY_LABEL.default}</option>
                <option value="authenticated-read">{POLICY_LABEL['authenticated-read']}</option>
                <option value="owner-only">{POLICY_LABEL['owner-only']}</option>
                <option value="public-read">{POLICY_LABEL['public-read']}</option>
              </select>
            </div>
            {bucketInfo.public && (
              <p className="mt-2 text-xs text-muted-foreground">
                Access rules apply to private buckets. A public bucket is readable at its direct storage URL regardless.
              </p>
            )}
            {policyMode === 'owner-only' && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs dark:border-amber-800 dark:bg-amber-950">
                <p className="text-amber-700 dark:text-amber-300">
                  Files uploaded before this rule was set carry no owner and stay unreachable for API-key callers
                  until they are uploaded again. The service key and team members keep full access.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Upload limits */}
      <section className="rounded-md border">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Upload limits</h2>
        </div>
        <div className="space-y-3 px-4 py-4">
          <p className="text-xs text-muted-foreground">
            Applied to every upload into this bucket, from the dashboard, the SDK or the API. Leave a field empty for no
            limit of this bucket&apos;s own (the platform-wide ceiling still applies).
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="bucket-max-mb" className="text-xs font-medium">Largest file (MB)</label>
              <Input
                id="bucket-max-mb"
                inputMode="decimal"
                placeholder="No bucket limit"
                value={maxMb}
                onChange={(e) => setMaxMb(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="bucket-types" className="text-xs font-medium">Allowed file types</label>
              <Input
                id="bucket-types"
                placeholder="Any type — e.g. image/*, application/pdf"
                value={types}
                onChange={(e) => setTypes(e.target.value)}
              />
            </div>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSaveLimits} disabled={limitsSaving}>
              {limitsSaving ? 'Saving…' : 'Save limits'}
            </Button>
          </div>
        </div>
      </section>

      {/* Danger zone */}
      <section className="rounded-md border border-red-200 dark:border-red-800">
        <div className="border-b border-red-200 px-4 py-3 dark:border-red-800">
          <h2 className="text-sm font-semibold text-red-600 dark:text-red-400">Danger Zone</h2>
        </div>
        <div className="flex items-center justify-between px-4 py-4">
          <div>
            <p className="text-sm font-medium">Delete bucket</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Permanently delete this bucket and all its files.
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={async () => {
              const ok = await confirmDialog({
                title: 'Delete bucket',
                description: `Delete bucket "${bucketName}" and all ${bucketInfo.objectCount} file(s) in it? This cannot be undone.`,
                confirmText: 'Delete bucket',
                destructive: true,
              });
              if (!ok) return;
              try {
                await api.storage.deleteBucket(projectId, bucketName);
                toast.success(`Bucket "${bucketName}" deleted`);
                onDeleted();
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

type ConflictAction = 'overwrite' | 'rename' | 'skip' | 'cancel';

function ObjectBrowser({
  projectId,
  bucketName,
  bucketInfo,
  prefix,
  onPrefixChange,
  onChanged,
}: {
  projectId: string;
  bucketName: string;
  bucketInfo: StorageBucket | null;
  prefix: string;
  onPrefixChange: (prefix: string) => void;
  onChanged: () => void;
}) {
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [urlLoading, setUrlLoading] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [moveSources, setMoveSources] = useState<string[] | null>(null);
  const [moveDest, setMoveDest] = useState('');
  const [moving, setMoving] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ title: string; names: { desired: string; free: string }[]; allowOverwrite: boolean } | null>(null);
  const [search, setSearch] = useState('');
  const [searchAll, setSearchAll] = useState(false);
  const [deepResults, setDeepResults] = useState<StorageObject[] | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [view, setView] = useState<ViewMode>('list');
  const [preview, setPreview] = useState<StorageObject | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragItemsRef = useRef<string[]>([]);
  const conflictResolver = useRef<((a: ConflictAction) => void) | null>(null);

  // The chosen view survives a reload.
  useEffect(() => {
    try {
      const saved = localStorage.getItem('storage-view');
      if (saved === 'grid' || saved === 'list') setView(saved);
    } catch {}
  }, []);
  function changeView(next: ViewMode) {
    setView(next);
    try {
      localStorage.setItem('storage-view', next);
    } catch {}
  }

  // Promise-based conflict prompt: resolves when the user picks an action.
  function askConflict(
    title: string,
    names: { desired: string; free: string }[],
    allowOverwrite = false,
  ): Promise<ConflictAction> {
    setConflict({ title, names, allowOverwrite });
    return new Promise((resolve) => { conflictResolver.current = resolve; });
  }
  function resolveConflict(action: ConflictAction) {
    setConflict(null);
    const r = conflictResolver.current;
    conflictResolver.current = null;
    r?.(action);
  }

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

  // "All folders" search asks the server for every match below this folder.
  useEffect(() => {
    const text = search.trim();
    if (!searchAll || !text) {
      setDeepResults(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api.storage
        .listObjects(projectId, bucketName, prefix, { search: text, recursive: true })
        .then((rows) => !cancelled && setDeepResults(rows))
        .catch((err: any) => !cancelled && toast.error(err.message));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, searchAll, projectId, bucketName, prefix]);

  async function afterChange() {
    await load();
    onChanged();
  }

  const breadcrumbs = prefix ? prefix.split('/').filter(Boolean) : [];
  const allFolders = objects.filter((o) => o.prefix);
  const allFiles = objects.filter((o) => !o.prefix && o.name);

  const { folders, files } = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const source = deepResults ?? objects;
    let fo = source.filter((o) => o.prefix);
    let fi = source.filter((o) => !o.prefix && o.name);
    if (needle && !deepResults) {
      const own = (o: StorageObject) => (o.prefix ?? o.name).replace(/\/$/, '').split('/').pop()!.toLowerCase();
      fo = fo.filter((o) => own(o).includes(needle));
      fi = fi.filter((o) => own(o).includes(needle));
    }
    const dir = order === 'asc' ? 1 : -1;
    const nameOf = (o: StorageObject) => (o.prefix ?? o.name).toLowerCase();
    const cmp = (a: StorageObject, b: StorageObject) => {
      if (sortBy === 'size') return (a.size - b.size) * dir;
      if (sortBy === 'lastModified') return (new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime()) * dir;
      return nameOf(a).localeCompare(nameOf(b)) * dir;
    };
    return { folders: [...fo].sort((a, b) => nameOf(a).localeCompare(nameOf(b)) * (sortBy === 'name' ? dir : 1)), files: [...fi].sort(cmp) };
  }, [objects, deepResults, search, sortBy, order]);

  // Both folders (by prefix) and files (by name) are selectable.
  const selectableKeys = [...folders.map((f) => f.prefix!), ...files.map((f) => f.name)];

  // Names already used at the current prefix (folders + files, type-agnostic).
  function existingNamesHere(): Set<string> {
    return new Set<string>([
      ...allFolders.map((f) => f.prefix!.slice(prefix.length).replace(/\/$/, '')),
      ...allFiles.map((f) => f.name.slice(prefix.length)),
    ]);
  }

  function toggleSort(key: SortKey) {
    if (sortBy === key) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(key);
      setOrder(key === 'name' ? 'asc' : 'desc');
    }
  }

  function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (sortBy !== key) return 'none';
    return order === 'asc' ? 'ascending' : 'descending';
  }

  // Begin dragging: if the grabbed row is part of the current selection, drag
  // the whole selection; otherwise just that one item.
  function startDrag(key: string) {
    dragItemsRef.current = selected.has(key) && selected.size > 0 ? Array.from(selected) : [key];
  }

  async function handleDropMove(destPrefix: string) {
    const items = dragItemsRef.current;
    dragItemsRef.current = [];
    setDragOver(null);
    const sources = (items || []).filter((s) => {
      if (s === destPrefix) return false; // dropped on itself
      if (s.endsWith('/') && destPrefix.startsWith(s)) return false; // folder into its own subtree
      return true;
    });
    if (!sources.length) return;
    try {
      const { moved } = await api.storage.moveObjects(projectId, bucketName, sources, destPrefix);
      toast.success(`Moved ${moved} item(s)`);
      setSelected(new Set());
      await afterChange();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // Big files go through a resumable session in chunks; small ones in one request.
  async function uploadOne(path: string, file: File) {
    if (file.size >= RESUMABLE_THRESHOLD) {
      try {
        await api.storage.uploadResumable(projectId, bucketName, path, file, setUploadProgress);
      } finally {
        setUploadProgress(null);
      }
    } else {
      await api.storage.upload(projectId, bucketName, path, file);
    }
  }

  async function handleUpload(fileList: FileList | null) {
    const all = Array.from(fileList ?? []);
    if (!all.length) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Resolve name clashes against what's already here (any type).
    const existing = existingNamesHere();
    const clashes = all.filter((f) => existing.has(f.name));
    let plan = all.map((f) => ({ file: f, name: f.name }));

    if (clashes.length) {
      const taken = new Set(existing);
      const renameMap = new Map<File, string>();
      for (const f of clashes) {
        const free = computeFreeName(f.name, taken);
        taken.add(free);
        renameMap.set(f, free);
      }
      const action = await askConflict(
        `${clashes.length} item(s) with the same name already exist here.`,
        clashes.map((f) => ({ desired: f.name, free: renameMap.get(f)! })),
        // A folder of the same name cannot be overwritten by a file.
        clashes.every((f) => allFiles.some((o) => o.name === prefix + f.name)),
      );
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (action === 'cancel') return;
      if (action === 'skip') plan = plan.filter((p) => !existing.has(p.name));
      if (action === 'rename') {
        plan = plan.map((p) => (existing.has(p.name) ? { file: p.file, name: renameMap.get(p.file)! } : p));
      }
      // 'overwrite' keeps the plan: the same path replaces the existing file.
    }

    if (!plan.length) {
      toast.message('Nothing to upload — all files were skipped.');
      return;
    }

    setUploading(true);
    try {
      for (const { file, name } of plan) {
        await uploadOne(prefix + name, file);
      }
      toast.success(`Uploaded ${plan.length} file(s)`);
      await afterChange();
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
        await uploadOne(path, file);
        done++;
      }
      toast.success(`Uploaded ${done} file(s) from the folder`);
      await afterChange();
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

    let finalName = name;
    const existing = existingNamesHere();
    if (existing.has(name)) {
      const free = computeFreeName(name, existing);
      const action = await askConflict(
        `A folder or file named "${name}" already exists here.`,
        [{ desired: name, free }],
      );
      if (action !== 'rename') return; // skip / cancel → don't create
      finalName = free;
    }

    try {
      await api.storage.createFolder(projectId, bucketName, prefix + finalName);
      toast.success(`Folder "${finalName}" created`);
      setNewFolderName('');
      setCreatingFolder(false);
      await afterChange();
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
      await afterChange();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setMoving(false);
    }
  }

  /** Rename a file or a folder in place; the new name may not contain "/". */
  async function handleRename(key: string) {
    const isFolder = key.endsWith('/');
    const current = key.replace(/\/$/, '').split('/').pop() || key;
    const parent = key.slice(0, key.length - current.length - (isFolder ? 1 : 0));
    const next = (
      await promptDialog({
        title: isFolder ? 'Rename folder' : 'Rename file',
        description: isFolder ? 'Everything inside the folder moves with it.' : undefined,
        defaultValue: current,
        confirmText: 'Rename',
      })
    )?.trim();
    if (!next || next === current) return;
    if (next.includes('/') || next === '.' || next === '..') {
      toast.error('A name cannot contain "/" and cannot be "." or "..".');
      return;
    }
    const to = `${parent}${next}${isFolder ? '/' : ''}`;
    try {
      await api.storage.renameObject(projectId, bucketName, key, to);
      toast.success(`Renamed to ${next}`);
      await afterChange();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDownload(objectName: string) {
    try {
      const blob = await fetchObject(projectId, bucketName, objectName);
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
      toast.success('Temporary link copied (valid for one hour)');
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setUrlLoading(null);
    }
  }

  async function handleDeleteSelected() {
    if (selected.size === 0) return;
    if (!(await confirmDialog({ title: 'Delete items', description: `Delete ${selected.size} item(s)? Folders are deleted with everything in them.`, destructive: true }))) return;
    try {
      const res = await api.storage.deleteObjects(projectId, bucketName, Array.from(selected));
      toast.success(res.message || `Deleted ${selected.size} item(s)`);
      await afterChange();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDeleteOne(file: StorageObject, fileName: string) {
    if (!(await confirmDialog({ title: 'Delete file', description: `Delete ${fileName}?`, destructive: true }))) return;
    try {
      await api.storage.deleteObjects(projectId, bucketName, [file.name]);
      toast.success(`Deleted ${fileName}`);
      await afterChange();
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
    setSelected(
      selectableKeys.length > 0 && selected.size === selectableKeys.length
        ? new Set()
        : new Set(selectableKeys),
    );
  }

  /** What a row shows: the name below the current folder (a deep search shows the path). */
  const shownName = (key: string) => key.slice(prefix.length);
  const thumbUrl = (key: string) =>
    `/api/proxy/projects/${projectId}/storage/public/${encodeURIComponent(bucketName)}?path=${encodeURIComponent(key)}`;

  const SortHeader = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => (
    <span className={className} aria-sort={ariaSort(k)} role="columnheader">
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className="inline-flex items-center gap-1 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        {sortBy === k && (order === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />)}
      </button>
    </span>
  );

  const fileActions = (file: StorageObject, fileName: string) => (
    <div className="flex justify-end gap-1">
      {previewKind(file.name) && (
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Preview" aria-label={`Preview ${fileName}`} onClick={() => setPreview(file)}>
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        title={isPublic ? 'Copy public link' : 'Copy temporary link'}
        aria-label={`Copy link to ${fileName}`}
        disabled={urlLoading === file.name}
        onClick={() => handleCopyUrl(file.name)}
      >
        {urlLoading === file.name ? (
          <div className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
        ) : (
          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" title="Rename" aria-label={`Rename ${fileName}`} onClick={() => handleRename(file.name)}>
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" className="h-7 w-7" title="Download" aria-label={`Download ${fileName}`} onClick={() => handleDownload(file.name)}>
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-destructive hover:text-destructive"
        title="Delete"
        aria-label={`Delete ${fileName}`}
        onClick={() => handleDeleteOne(file, fileName)}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );

  const empty = folders.length === 0 && files.length === 0;

  return (
    <div className="w-full min-w-0 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-[14rem] flex-1 items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchAll ? 'Search this folder and below' : 'Search this folder'}
              aria-label="Search files and folders"
              className="h-8 pl-7 pr-7"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <input type="checkbox" className="h-3.5 w-3.5 rounded" checked={searchAll} onChange={(e) => setSearchAll(e.target.checked)} />
            All subfolders
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex rounded-md border" role="group" aria-label="View">
            <Button
              variant={view === 'list' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 rounded-r-none"
              onClick={() => changeView('list')}
              aria-label="List view"
              aria-pressed={view === 'list'}
            >
              <List className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant={view === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              className="h-8 w-8 rounded-l-none"
              onClick={() => changeView('grid')}
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </Button>
          </div>
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
            {uploading ? (uploadProgress ? `Uploading… ${uploadProgress.percent}%` : 'Uploading…') : 'Upload'}
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
      </div>

      {creatingFolder && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2">
          <FolderPlus className="h-4 w-4 text-blue-500" aria-hidden="true" />
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder();
              if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); }
            }}
            placeholder="Folder name"
            aria-label="Folder name"
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
      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <button
          onClick={() => onPrefixChange('')}
          onDragOver={(e) => { e.preventDefault(); setDragOver(':root:'); }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(null); }}
          onDrop={(e) => { e.preventDefault(); handleDropMove(''); }}
          className={`flex items-center gap-1 rounded px-1 font-medium text-primary hover:underline ${dragOver === ':root:' ? 'bg-primary/15 ring-1 ring-primary' : ''}`}
        >
          <HardDrive className="h-3.5 w-3.5" aria-hidden="true" />
          {bucketName}
        </button>
        {breadcrumbs.map((crumb, i) => {
          const crumbPrefix = breadcrumbs.slice(0, i + 1).join('/') + '/';
          return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <button
              onClick={() => onPrefixChange(crumbPrefix)}
              onDragOver={(e) => { e.preventDefault(); setDragOver(crumbPrefix); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(null); }}
              onDrop={(e) => { e.preventDefault(); handleDropMove(crumbPrefix); }}
              aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}
              className={`rounded px-1 ${dragOver === crumbPrefix ? 'bg-primary/15 ring-1 ring-primary' : i === breadcrumbs.length - 1 ? 'font-medium' : 'text-primary hover:underline'}`}
            >
              {crumb}
            </button>
          </span>
          );
        })}
      </nav>

      {deepResults && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {folders.length + files.length} match(es) for &quot;{search.trim()}&quot; in this folder and its subfolders.
        </p>
      )}

      {/* File list / grid */}
      {loading ? (
        <div className="flex h-32 items-center justify-center rounded-md border">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : empty ? (
        <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-md border text-muted-foreground">
          <Folder className="h-8 w-8" aria-hidden="true" />
          {search.trim() ? (
            <p className="text-sm">No files or folders match &quot;{search.trim()}&quot;</p>
          ) : (
            <>
              <p className="text-sm">{prefix ? 'This folder is empty' : 'This bucket is empty'}</p>
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Upload files
              </Button>
            </>
          )}
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {folders.map((folder) => {
            const label = shownName(folder.prefix!).replace(/\/$/, '');
            return (
              <div
                key={folder.prefix}
                className={`group relative flex flex-col items-center gap-2 rounded-md border p-3 text-center text-xs ${selected.has(folder.prefix!) ? 'bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/30'}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(folder.prefix!); }}
                onDrop={(e) => { e.preventDefault(); handleDropMove(folder.prefix!); }}
              >
                <input
                  type="checkbox"
                  className="absolute left-2 top-2 h-3.5 w-3.5 rounded"
                  checked={selected.has(folder.prefix!)}
                  onChange={() => toggleSelect(folder.prefix!)}
                  aria-label={`Select folder ${label}`}
                />
                <button type="button" onClick={() => { setSearch(''); onPrefixChange(folder.prefix!); }} className="flex flex-col items-center gap-2">
                  <Folder className="h-10 w-10 text-blue-500" aria-hidden="true" />
                  <span className="w-full truncate font-medium" title={label}>{label}</span>
                </button>
              </div>
            );
          })}
          {files.map((file) => {
            const fileName = shownName(file.name);
            const kind = previewKind(file.name);
            return (
              <div
                key={file.name}
                draggable
                onDragStart={() => startDrag(file.name)}
                className={`group relative flex flex-col gap-2 rounded-md border p-2 text-xs ${selected.has(file.name) ? 'bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/30'}`}
              >
                <input
                  type="checkbox"
                  className="absolute left-2 top-2 z-10 h-3.5 w-3.5 rounded"
                  checked={selected.has(file.name)}
                  onChange={() => toggleSelect(file.name)}
                  aria-label={`Select ${fileName}`}
                />
                <button
                  type="button"
                  onClick={() => (kind ? setPreview(file) : handleDownload(file.name))}
                  className="flex aspect-square items-center justify-center overflow-hidden rounded bg-muted/40"
                  aria-label={kind ? `Preview ${fileName}` : `Download ${fileName}`}
                >
                  {kind === 'image' && isPublic ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumbUrl(file.name)} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <FileIcon name={fileName} large />
                  )}
                </button>
                <span className="truncate" title={fileName}>{fileName}</span>
                <span className="text-muted-foreground">{formatBytes(file.size)}</span>
                <div className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                  {fileActions(file, fileName)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border" role="table" aria-label={`Files in ${bucketName}`}>
          <div role="row" className="flex min-w-[44rem] items-center gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
            <span role="columnheader">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded"
                checked={selectableKeys.length > 0 && selected.size === selectableKeys.length}
                onChange={toggleSelectAll}
                aria-label="Select all"
              />
            </span>
            <SortHeader k="name" label="Name" className="flex-1" />
            <SortHeader k="size" label="Size" className="w-24 text-right" />
            <SortHeader k="lastModified" label="Last Modified" className="w-44 text-right" />
            <span className="w-40" role="columnheader"><span className="sr-only">Actions</span></span>
          </div>

          {folders.map((folder) => {
            const folderChecked = selected.has(folder.prefix!);
            const label = shownName(folder.prefix!).replace(/\/$/, '');
            return (
            <div
              key={folder.prefix}
              role="row"
              draggable
              onDragStart={() => startDrag(folder.prefix!)}
              onDragOver={(e) => { e.preventDefault(); setDragOver(folder.prefix!); }}
              onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(null); }}
              onDrop={(e) => { e.preventDefault(); handleDropMove(folder.prefix!); }}
              className={`flex min-w-[44rem] items-center gap-3 border-b px-4 py-2.5 text-sm transition-colors ${dragOver === folder.prefix ? 'bg-primary/10 ring-1 ring-inset ring-primary' : folderChecked ? 'bg-primary/5' : 'hover:bg-muted/30'}`}
            >
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded"
                checked={folderChecked}
                onChange={() => toggleSelect(folder.prefix!)}
                aria-label={`Select folder ${label}`}
              />
              <button
                onClick={() => { setSearch(''); onPrefixChange(folder.prefix!); }}
                className="flex flex-1 items-center gap-3 text-left"
              >
                <Folder className="h-4 w-4 text-blue-500" aria-hidden="true" />
                <span className="flex-1 font-medium">{label}</span>
              </button>
              <span className="w-24 text-right text-muted-foreground">—</span>
              <span className="w-44 text-right text-muted-foreground">—</span>
              <div className="flex w-40 justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Rename folder"
                  aria-label={`Rename folder ${label}`}
                  onClick={() => handleRename(folder.prefix!)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Move folder"
                  aria-label={`Move folder ${label}`}
                  onClick={() => { setMoveSources([folder.prefix!]); setMoveDest(''); }}
                >
                  <FolderInput className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
            );
          })}

          {files.map((file) => {
            const fileName = shownName(file.name);
            const isChecked = selected.has(file.name);
            return (
              <div
                key={file.name}
                role="row"
                draggable
                onDragStart={() => startDrag(file.name)}
                className={`flex min-w-[44rem] items-center gap-3 border-b px-4 py-2.5 text-sm transition-colors ${isChecked ? 'bg-primary/5' : 'hover:bg-muted/30'}`}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded"
                  checked={isChecked}
                  onChange={() => toggleSelect(file.name)}
                  aria-label={`Select ${fileName}`}
                />
                <FileIcon name={fileName} />
                {previewKind(file.name) ? (
                  <button type="button" onClick={() => setPreview(file)} className="flex-1 truncate text-left hover:underline">
                    {fileName}
                  </button>
                ) : (
                  <span className="flex-1 truncate">{fileName}</span>
                )}
                <span className="w-24 text-right text-muted-foreground">{formatBytes(file.size)}</span>
                <span className="w-44 text-right text-muted-foreground">{formatDate(file.lastModified)}</span>
                <div className="w-40">{fileActions(file, fileName)}</div>
              </div>
            );
          })}
        </div>
      )}

      {preview && (
        <PreviewDialog
          projectId={projectId}
          bucketName={bucketName}
          object={preview}
          onClose={() => setPreview(null)}
          onDownload={() => handleDownload(preview.name)}
        />
      )}

      {moveSources && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !moving && setMoveSources(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="move-dialog-title" className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 id="move-dialog-title" className="text-base font-semibold">Move {moveSources.length} item(s)</h3>
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
                {allFolders
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
                aria-label="Destination folder"
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

      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => resolveConflict('cancel')}>
          <div role="dialog" aria-modal="true" aria-labelledby="conflict-dialog-title" className="w-full max-w-md rounded-lg border bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 id="conflict-dialog-title" className="text-base font-semibold">Name already exists</h3>
            <p className="mt-1 text-xs text-muted-foreground">{conflict.title}</p>
            <div className="mt-3 max-h-48 space-y-1 overflow-auto rounded-md border bg-muted/20 p-2 text-xs">
              {conflict.names.map((n) => (
                <div key={n.desired} className="flex items-center justify-between gap-2">
                  <span className="truncate text-muted-foreground">{n.desired}</span>
                  <span className="shrink-0 text-foreground">or keep both as {n.free}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              <strong>Overwrite</strong> replaces the existing file. <strong>Keep both</strong> adds _2, _3…{' '}
              <strong>Skip</strong> leaves the existing one untouched.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => resolveConflict('cancel')}>
                Cancel
              </Button>
              <Button variant="outline" size="sm" onClick={() => resolveConflict('skip')}>
                Skip
              </Button>
              <Button variant="outline" size="sm" onClick={() => resolveConflict('rename')}>
                Keep both
              </Button>
              {conflict.allowOverwrite && (
                <Button size="sm" variant="destructive" onClick={() => resolveConflict('overwrite')}>
                  Overwrite
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Preview ──────────────────────────────────────────────

function PreviewDialog({
  projectId,
  bucketName,
  object,
  onClose,
  onDownload,
}: {
  projectId: string;
  bucketName: string;
  object: StorageObject;
  onClose: () => void;
  onDownload: () => void;
}) {
  const kind = previewKind(object.name);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tooBig = object.size > PREVIEW_MAX_BYTES;
  const name = object.name.split('/').pop() || object.name;

  useEffect(() => {
    if (tooBig || !kind) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchObject(projectId, bucketName, object.name)
      .then(async (blob) => {
        if (cancelled) return;
        if (kind === 'text') {
          const head = await blob.slice(0, TEXT_PREVIEW_BYTES).text();
          if (!cancelled) setText(head + (blob.size > TEXT_PREVIEW_BYTES ? '\n…' : ''));
          return;
        }
        // The download route sends the stored type; a PDF frame needs it explicitly.
        const typed = kind === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob;
        objectUrl = URL.createObjectURL(typed);
        setUrl(objectUrl);
      })
      .catch((err: any) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, bucketName, object.name, kind, tooBig]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-title"
        className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <div className="min-w-0">
            <h3 id="preview-title" className="truncate text-sm font-semibold">{name}</h3>
            <p className="text-xs text-muted-foreground">{formatBytes(object.size)} · {formatDate(object.lastModified)}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="outline" size="sm" onClick={onDownload}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close preview">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex min-h-[12rem] flex-1 items-center justify-center overflow-auto p-4">
          {tooBig ? (
            <p className="text-sm text-muted-foreground">This file is too large to preview here. Download it instead.</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : kind === 'text' ? (
            text === null ? (
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            ) : (
              <pre className="max-h-[70vh] w-full overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-3 text-xs">{text}</pre>
            )
          ) : !url ? (
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : kind === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={name} className="max-h-[70vh] max-w-full object-contain" />
          ) : kind === 'pdf' ? (
            <iframe src={url} title={name} className="h-[70vh] w-full rounded border" />
          ) : kind === 'video' ? (
            <video src={url} controls className="max-h-[70vh] max-w-full" />
          ) : kind === 'audio' ? (
            <audio src={url} controls className="w-full" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FileIcon({ name, large = false }: { name: string; large?: boolean }) {
  const ext = extOf(name);
  const codeExts = ['ts', 'tsx', 'js', 'jsx', 'json', 'html', 'css', 'py', 'go', 'rs'];

  let color = 'text-muted-foreground';
  if (IMAGE_EXTS.includes(ext)) color = 'text-green-500';
  else if (codeExts.includes(ext)) color = 'text-orange-500';
  else if (ext === 'pdf') color = 'text-red-500';

  return <File className={`${large ? 'h-10 w-10' : 'h-4 w-4'} ${color}`} aria-hidden="true" />;
}
