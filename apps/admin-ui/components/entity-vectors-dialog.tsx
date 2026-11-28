'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { EntityVectorSearchResult, EntityVectorStatus } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertTriangle, RefreshCw, Search, Sparkles } from 'lucide-react';

/** Dot paths of the scalar fields of an entity definition, in field order. */
export function entityFieldPaths(fields: unknown[], prefix = ''): string[] {
  const out: string[] = [];
  for (const f of fields ?? []) {
    if (!f || typeof f !== 'object') continue;
    const field = f as { name?: unknown; kind?: unknown; children?: unknown };
    if (typeof field.name !== 'string' || !field.name) continue;
    const path = prefix ? `${prefix}.${field.name}` : field.name;
    if (field.kind === 'object' && Array.isArray(field.children)) {
      out.push(...entityFieldPaths(field.children, path));
    } else {
      // Scalars and arrays: an array's items are embedded as JSON text.
      out.push(path);
    }
  }
  return out;
}

const PLAN_HINT =
  "Computing embeddings with the platform's key is available on the Pro plan and above. Upgrade your team plan under Billing, or add your own embedding provider key in the project's AI settings.";

function errorText(err: any): string {
  return err?.message || 'Request failed';
}

/**
 * Vectors of one Data Engine entity: the current setup and counts, a form to
 * turn on platform mode (vectors computed from chosen fields) or client mode
 * (your own vectors of a fixed width), a re-embed with progress, and a text
 * search over a platform-mode entity.
 */
export function EntityVectorsDialog({
  open,
  onOpenChange,
  projectId,
  entityName,
  fields,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  entityName: string;
  fields: unknown[];
}) {
  const [status, setStatus] = useState<EntityVectorStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [mode, setMode] = useState<'platform' | 'client'>('platform');
  const [paths, setPaths] = useState<string[]>([]);
  const [dimensions, setDimensions] = useState('1536');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<EntityVectorSearchResult | null>(null);

  const fieldPaths = useMemo(() => entityFieldPaths(fields), [fields]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api.projects.entityVectorStatus(projectId, entityName);
      setStatus(s);
      setUnsupported(null);
      return s;
    } catch (err: any) {
      if (err?.code === 'VECTOR_NOT_SUPPORTED' || err?.status === 501) setUnsupported(errorText(err));
      else toast.error(errorText(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, entityName]);

  // Load on open, and take the form defaults from the current setup.
  useEffect(() => {
    if (!open) return;
    setResults(null);
    load().then((s) => {
      if (!s) return;
      if (s.mode === 'client') {
        setMode('client');
        setDimensions(String(s.dimensions ?? 1536));
      } else {
        setMode('platform');
        setPaths(s.sourcePaths ?? []);
      }
    });
  }, [open, load]);

  // Follow a running re-embed.
  const running = status?.reembed?.status === 'QUEUED' || status?.reembed?.status === 'RUNNING';
  const pendingWork = status?.mode === 'platform' && (status.pending ?? 0) > 0;
  useEffect(() => {
    if (!open || (!running && !pendingWork)) return;
    const h = setInterval(() => void load(), running ? 3000 : 6000);
    return () => clearInterval(h);
  }, [open, running, pendingWork, load]);

  const platformBlocked = status?.platformKeyAllowed === false;
  const hasVectors = (status?.embedded ?? 0) > 0;

  function togglePath(p: string) {
    setPaths((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : cur.length >= 8 ? cur : [...cur, p]));
  }

  async function save() {
    if (mode === 'platform' && paths.length === 0) {
      toast.error('Choose at least one field to embed');
      return;
    }
    const dims = Number(dimensions);
    if (mode === 'client' && (!Number.isInteger(dims) || dims < 1 || dims > 2048)) {
      toast.error('Dimensions must be a whole number from 1 to 2048');
      return;
    }
    const switching = !!status?.mode && status.mode !== mode;
    const widthChange = mode === 'client' && status?.mode === 'client' && status.dimensions !== dims;
    let purge = false;
    if (hasVectors && (switching || widthChange)) {
      purge = await confirmDialog({
        title: 'Delete existing vectors?',
        description: `This entity holds ${status!.embedded} vectors that do not fit the new setup. They are deleted before the change.`,
        confirmText: 'Delete and change',
        destructive: true,
      });
      if (!purge) return;
    }
    setSaving(true);
    try {
      await api.projects.setEntityVectorConfig(
        projectId,
        entityName,
        mode === 'platform' ? { mode, sourcePaths: paths } : { mode, dimensions: dims },
        { purge },
      );
      toast.success(mode === 'platform' ? 'Platform vectors on; existing records are being embedded' : 'Client vectors on');
      await load();
    } catch (err: any) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function turnOff() {
    const ok = await confirmDialog({
      title: 'Turn vectors off?',
      description: hasVectors
        ? `The ${status!.embedded} stored vectors of this entity are deleted. Records are not changed.`
        : 'The entity stops storing vectors. Records are not changed.',
      confirmText: 'Turn off',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.projects.deleteEntityVectorConfig(projectId, entityName, { purge: true });
      toast.success('Vectors turned off');
      setResults(null);
      await load();
    } catch (err: any) {
      toast.error(errorText(err));
    }
  }

  async function reembed() {
    try {
      await api.projects.reembedEntity(projectId, entityName);
      toast.success('Re-embed started');
      await load();
    } catch (err: any) {
      toast.error(errorText(err));
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      setResults(await api.projects.searchEntityVectors(projectId, entityName, { query: query.trim(), limit: 10 }));
    } catch (err: any) {
      setResults(null);
      toast.error(errorText(err));
    } finally {
      setSearching(false);
    }
  }

  const reembedState = status?.reembed;
  const progress = reembedState && reembedState.total > 0 ? Math.min(100, Math.round((reembedState.done / reembedState.total) * 100)) : 0;
  const daily = status?.dailyTokens;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Vectors</DialogTitle>
          <DialogDescription>
            Vector embeddings stored alongside the records of <strong>{entityName}</strong>, for similarity search.
          </DialogDescription>
        </DialogHeader>

        {unsupported ? (
          <p className="text-sm text-muted-foreground">{unsupported}</p>
        ) : !status ? (
          <div className="flex items-center justify-center py-10">
            <div className="h-5 w-5 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : (
          <div className="space-y-5 text-sm">
            {/* Current state */}
            <section className="rounded-md border p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">Current</span>
                {status.mode ? (
                  <>
                    <Badge variant="secondary" className="text-[10px]">{status.mode}</Badge>
                    <Badge variant="outline" className="text-[10px]">{status.dimensions} dimensions</Badge>
                    {status.modelTag && <Badge variant="outline" className="text-[10px] font-mono">{status.modelTag}</Badge>}
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">off — this entity stores no vectors</span>
                )}
                <Button variant="ghost" size="icon" className="ml-auto h-7 w-7" onClick={() => void load()} title="Refresh">
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </Button>
              </div>
              {status.mode && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-xs">
                  <div><div className="text-muted-foreground">Embedded</div><div className="font-mono">{status.embedded} / {status.total}</div></div>
                  {status.mode === 'platform' && (
                    <>
                      <div><div className="text-muted-foreground">Pending</div><div className="font-mono">{status.pending ?? 0}</div></div>
                      <div><div className="text-muted-foreground">Failed</div><div className={cn('font-mono', (status.failed ?? 0) > 0 && 'text-destructive')}>{status.failed ?? 0}</div></div>
                    </>
                  )}
                  {status.sourcePaths && (
                    <div className="col-span-2 sm:col-span-1"><div className="text-muted-foreground">Fields</div><div className="font-mono truncate" title={status.sourcePaths.join(', ')}>{status.sourcePaths.join(', ')}</div></div>
                  )}
                </div>
              )}
              {status.mismatch && (
                <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  The project now embeds with {status.currentModelTag}. Text search is paused until a re-embed finishes.
                </p>
              )}
              {status.mode === 'platform' && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={reembed} disabled={running || platformBlocked}>
                      <Sparkles className="mr-1 h-3.5 w-3.5" /> Re-embed
                    </Button>
                    {reembedState && (
                      <span className="text-xs text-muted-foreground">
                        Last run: {reembedState.status.toLowerCase()} · {reembedState.done}/{reembedState.total}
                        {reembedState.failed > 0 && ` · ${reembedState.failed} failed`}
                      </span>
                    )}
                  </div>
                  {running && (
                    <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                      <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                    </div>
                  )}
                  {reembedState?.status === 'FAILED' && reembedState.lastError && (
                    <p className="text-xs text-destructive break-words">{reembedState.lastError}</p>
                  )}
                </div>
              )}
            </section>

            {platformBlocked && (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" />
                {PLAN_HINT} Client mode (your own vectors) works on every plan.
              </p>
            )}
            {daily && daily.limit !== null && !platformBlocked && (
              <p className="text-xs text-muted-foreground">
                Platform key: {(daily.used ?? 0).toLocaleString('en-US')} of {daily.limit.toLocaleString('en-US')} embedding
                tokens used today (resets {daily.resetsAt ? new Date(daily.resetsAt).toLocaleString() : 'at 00:00 UTC'}).
              </p>
            )}

            {/* Setup */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="font-medium">Setup</span>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant={mode === 'platform' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setMode('platform')}>
                    Platform computes
                  </Button>
                  <Button size="sm" variant={mode === 'client' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setMode('client')}>
                    I send vectors
                  </Button>
                </div>
              </div>
              {mode === 'platform' ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Choose up to 8 fields. Their text is joined in the order you pick them and embedded with the project&apos;s
                    embedding model after every write.
                  </p>
                  {fieldPaths.length === 0 ? (
                    <p className="text-xs text-muted-foreground">This entity declares no fields.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {fieldPaths.map((p) => {
                        const idx = paths.indexOf(p);
                        return (
                          <button
                            key={p}
                            type="button"
                            onClick={() => togglePath(p)}
                            className={cn(
                              'rounded border px-2 py-0.5 font-mono text-xs transition-colors',
                              idx >= 0 ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
                            )}
                          >
                            {idx >= 0 && <span className="mr-1 text-[10px]">{idx + 1}</span>}
                            {p}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Dimensions</span>
                  <Input
                    className="h-8 w-28 text-xs font-mono"
                    inputMode="numeric"
                    value={dimensions}
                    onChange={(e) => setDimensions(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                  <span className="text-xs text-muted-foreground">1 to 2048; send vectors with the API or SDK.</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-8 text-xs" onClick={save} disabled={saving || (mode === 'platform' && platformBlocked)}>
                  {saving ? 'Saving...' : status.mode ? 'Save setup' : 'Turn on'}
                </Button>
                {status.mode && (
                  <Button size="sm" variant="ghost" className="h-8 text-xs text-destructive" onClick={turnOff}>
                    Turn off
                  </Button>
                )}
              </div>
            </section>

            {/* Search */}
            {status.mode === 'platform' && (
              <section className="space-y-2">
                <span className="font-medium">Search</span>
                <form onSubmit={search} className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-8 pl-8 text-xs"
                      placeholder="Search by meaning, e.g. waterproof hiking boots"
                      value={query}
                      maxLength={8000}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <Button type="submit" size="sm" className="h-8 text-xs" disabled={searching || !query.trim() || status.mismatch || platformBlocked}>
                    {searching ? 'Searching...' : 'Search'}
                  </Button>
                </form>
                {results && (
                  results.data.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No record is close enough ({results.scanned} compared).</p>
                  ) : (
                    <div className="divide-y rounded-md border">
                      {results.data.map((hit) => {
                        const { _id, _entity, _projectId, _schemaVersion, _version, _eventSequence, _status, _createdAt, _updatedAt, _createdBy, _deletedAt, _distance, _score, ...userData } = hit;
                        const preview = JSON.stringify(userData);
                        return (
                          <div key={hit._id} className="flex items-start gap-3 px-3 py-2">
                            <span className="font-mono text-xs tabular-nums w-12 shrink-0">{_score.toFixed(3)}</span>
                            <div className="min-w-0">
                              <code className="text-[10px] text-muted-foreground font-mono">{hit._id}</code>
                              <p className="text-xs text-muted-foreground truncate font-mono">
                                {preview.length > 200 ? preview.slice(0, 200) + '...' : preview}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
