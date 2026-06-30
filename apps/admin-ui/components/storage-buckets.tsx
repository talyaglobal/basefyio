'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { StorageBucket } from '@basefyio/sdk';
import { getSdk } from '@/lib/sdk';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HardDrive, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';

interface StorageBucketsProps {
  projectId: string;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function StorageBuckets({ projectId }: StorageBucketsProps) {
  const [buckets, setBuckets] = useState<StorageBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPublic, setNewPublic] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadBuckets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getSdk().withProject(projectId).storage.listBuckets();
      setBuckets(data);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load buckets');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadBuckets(); }, [loadBuckets]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await getSdk().withProject(projectId).storage.createBucket({ name: newName.trim(), public: newPublic });
      toast.success(`Bucket "${newName}" created`);
      setCreateOpen(false);
      setNewName('');
      setNewPublic(false);
      await loadBuckets();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create bucket');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(bucketName: string) {
    if (!confirm(`Delete bucket "${bucketName}"? This cannot be undone.`)) return;
    setDeletingName(bucketName);
    try {
      await getSdk().withProject(projectId).storage.deleteBucket(bucketName);
      toast.success(`Bucket "${bucketName}" deleted`);
      setBuckets((prev) => prev.filter((b) => b.name !== bucketName));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete bucket');
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Buckets</h2>
          <p className="text-sm text-muted-foreground">{buckets.length} bucket{buckets.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { void loadBuckets(); }} disabled={loading}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="mr-1.5 h-4 w-4" />New bucket</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader><DialogTitle>Create bucket</DialogTitle></DialogHeader>
              <form onSubmit={(e) => { void handleCreate(e); }} className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="bucket-name">Name</Label>
                  <Input id="bucket-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-bucket" required autoFocus />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    id="bucket-public"
                    type="checkbox"
                    checked={newPublic}
                    onChange={(e) => setNewPublic(e.target.checked)}
                    className="h-4 w-4 rounded border-input"
                  />
                  <Label htmlFor="bucket-public" className="font-normal">Public (allow unauthenticated reads)</Label>
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
                  <Button type="submit" disabled={creating || !newName.trim()}>
                    {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                    Create
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loading && buckets.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : buckets.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12 text-center">
          <HardDrive className="mb-3 h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm font-medium">No buckets yet</p>
          <p className="mt-1 text-xs text-muted-foreground">Create a bucket to start storing files.</p>
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {buckets.map((bucket) => (
            <div key={bucket.name} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <HardDrive className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{bucket.name}</span>
                    <Badge variant={bucket.public ? 'secondary' : 'outline'} className="text-xs">
                      {bucket.public ? 'Public' : 'Private'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">Created {formatDate(bucket.createdAt)}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                disabled={deletingName === bucket.name}
                onClick={() => { void handleDelete(bucket.name); }}
              >
                {deletingName === bucket.name ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
