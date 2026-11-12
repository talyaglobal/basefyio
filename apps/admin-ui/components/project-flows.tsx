'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import type { Flow, FlowRun } from '@/lib/types';
import { describeCron } from '@/lib/flow-cron';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FlowEditorDialog, TRIGGER_LABELS } from '@/components/flows/flow-editor-dialog';
import {
  FlowRunDetailsDialog,
  RUN_SOURCE_LABELS,
  formatDuration,
  formatWhen,
  runDuration,
  runStatusClass,
} from '@/components/flows/flow-run-details';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
} from 'lucide-react';

const RUNS_PAGE = 20;

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          toast.error('Could not copy to the clipboard');
        }
      }}
    >
      {done ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />} {label ?? 'Copy'}
    </Button>
  );
}

interface SecretView {
  flowName: string;
  webhookUrl: string;
  secret: string;
  /** true when the secret was just created and is shown for the first time */
  fresh: boolean;
}

function WebhookSecretDialog({ view, onClose }: { view: SecretView | null; onClose: () => void }) {
  const curl = view
    ? `curl -X POST '${view.webhookUrl}' \\\n  -H 'X-Webhook-Secret: ${view.secret}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"event":"test"}'`
    : '';
  return (
    <Dialog open={!!view} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Webhook for “{view?.flowName}”</DialogTitle>
          <DialogDescription>
            {view?.fresh
              ? 'Copy the secret now and store it with the caller. You can reveal it again later, but treat it like a password.'
              : 'Anyone with this secret can start the flow. Keep it private.'}
          </DialogDescription>
        </DialogHeader>
        {view && (
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">URL</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">{view.webhookUrl}</code>
                <CopyButton value={view.webhookUrl} />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Secret</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">{view.secret}</code>
                <CopyButton value={view.secret} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Send the secret in the <code className="font-mono">X-Webhook-Secret</code> header (or as{' '}
              <code className="font-mono">Authorization: Bearer</code>), or sign the body with it:{' '}
              <code className="font-mono">X-Basefyio-Signature: sha256=…</code> (GitHub’s{' '}
              <code className="font-mono">X-Hub-Signature-256</code> works too). Never put it in the URL. The JSON body becomes{' '}
              <code className="font-mono">{'{{input}}'}</code>.
            </p>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Try it</span>
                <CopyButton value={curl} />
              </div>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">{curl}</pre>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectFlows({ projectId }: { projectId: string }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Flow | null>(null);
  const [secretView, setSecretView] = useState<SecretView | null>(null);

  const load = useCallback(async () => {
    try {
      setFlows(await api.flows.list(projectId));
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load flows');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (flow: Flow) => {
    setEditing(flow);
    setEditorOpen(true);
  };

  const onSaved = (saved: Flow) => {
    if (saved.webhookSecret && saved.webhookUrl) {
      setSecretView({ flowName: saved.name, webhookUrl: saved.webhookUrl, secret: saved.webhookSecret, fresh: true });
    } else if (saved.trigger?.type === 'webhook' && !saved.webhookUrl) {
      toast.warning('The flow was saved, but its webhook URL could not be created on this installation.');
    }
    load();
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Workflow className="h-5 w-5 text-primary" /> Flows
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Automate work with triggers and actions. A flow runs its actions in order — on demand, on a schedule, or when its webhook is called.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1 h-4 w-4" /> New flow
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : flows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No flows yet. Create your first automation.
        </div>
      ) : (
        <div className="space-y-3">
          {flows.map((flow) => (
            <FlowCard
              key={flow.id}
              projectId={projectId}
              flow={flow}
              onChanged={load}
              onEdit={() => openEdit(flow)}
              onShowSecret={setSecretView}
            />
          ))}
        </div>
      )}

      <FlowEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        projectId={projectId}
        flow={editing}
        onSaved={onSaved}
      />
      <WebhookSecretDialog view={secretView} onClose={() => setSecretView(null)} />
    </div>
  );
}

function ScheduleLine({ flow }: { flow: Flow }) {
  if (flow.trigger?.type !== 'schedule') return null;
  if (flow.scheduleError) {
    return (
      <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" /> This schedule cannot run: {flow.scheduleError}. Edit the flow to set a valid cron.
      </div>
    );
  }
  const tz = flow.trigger.timezone || 'UTC';
  return (
    <div className="text-xs text-muted-foreground">
      {describeCron(flow.trigger.cron ?? '')} ({tz}) · <code className="font-mono">{flow.trigger.cron}</code>
      {flow.enabled && flow.nextRunAt ? <> · next run {formatWhen(flow.nextRunAt)}</> : null}
      {!flow.enabled && <> · paused while disabled</>}
    </div>
  );
}

function WebhookLine({
  projectId,
  flow,
  onChanged,
  onShowSecret,
}: {
  projectId: string;
  flow: Flow;
  onChanged: () => void;
  onShowSecret: (v: SecretView) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (flow.trigger?.type !== 'webhook') return null;

  const reveal = async () => {
    setBusy(true);
    try {
      const r = await api.flows.revealWebhook(projectId, flow.id);
      onShowSecret({ flowName: flow.name, webhookUrl: r.webhookUrl, secret: r.secret, fresh: false });
    } catch (e: any) {
      toast.error(e?.message || 'Could not reveal the secret');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (flow.webhookUrl) {
      const ok = await confirmDialog({
        title: 'Create a new webhook URL and secret',
        description: 'The current URL and secret stop working immediately. Callers must be updated with the new ones.',
        confirmText: 'Create new',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api.flows.rotateWebhook(projectId, flow.id);
      if (r.secret) onShowSecret({ flowName: flow.name, webhookUrl: r.webhookUrl, secret: r.secret, fresh: true });
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Could not create the webhook URL');
    } finally {
      setBusy(false);
    }
  };

  if (!flow.webhookUrl) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        This flow has no webhook URL yet.
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={rotate} disabled={busy}>
          <KeyRound className="mr-1 h-3 w-3" /> Create webhook URL
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono">{flow.webhookUrl}</code>
      <CopyButton value={flow.webhookUrl} label="Copy URL" />
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={reveal} disabled={busy || !flow.hasWebhookSecret}>
        <Eye className="mr-1 h-3 w-3" /> Reveal secret
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={rotate} disabled={busy}>
        <RefreshCw className="mr-1 h-3 w-3" /> Rotate
      </Button>
    </div>
  );
}

function FlowCard({
  projectId,
  flow,
  onChanged,
  onEdit,
  onShowSecret,
}: {
  projectId: string;
  flow: Flow;
  onChanged: () => void;
  onEdit: () => void;
  onShowSecret: (v: SecretView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<FlowRun[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const page = await api.flows.runs(projectId, flow.id, { limit: RUNS_PAGE });
      if (!mounted.current) return;
      setRuns(page);
      setHasMore(page.length === RUNS_PAGE);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load runs');
    }
  }, [projectId, flow.id]);

  const loadMore = async () => {
    if (!runs?.length) return;
    setLoadingMore(true);
    try {
      const page = await api.flows.runs(projectId, flow.id, { limit: RUNS_PAGE, before: runs[runs.length - 1].id });
      setRuns([...runs, ...page]);
      setHasMore(page.length === RUNS_PAGE);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load runs');
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api.flows.setEnabled(projectId, flow.id, enabled);
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update flow');
    } finally {
      setBusy(false);
    }
  };

  /** Follow a queued run until it settles, then say how it actually went. */
  const watchRun = async (runId: string) => {
    const toastId = toast.loading('Run queued…');
    const deadline = Date.now() + 120_000;
    try {
      while (Date.now() < deadline && mounted.current) {
        await new Promise((r) => setTimeout(r, 1200));
        const r = await api.flows.run(projectId, flow.id, runId);
        if (r.status === 'running') toast.loading('Running…', { id: toastId });
        if (r.status === 'success') {
          toast.success(`Run succeeded in ${formatDuration(runDuration(r))}`, {
            id: toastId,
            action: { label: 'Details', onClick: () => setDetailRunId(runId) },
          });
          break;
        }
        if (r.status === 'failed') {
          toast.error(r.error || 'Run failed', {
            id: toastId,
            duration: 10_000,
            action: { label: 'Details', onClick: () => setDetailRunId(runId) },
          });
          break;
        }
      }
      if (Date.now() >= deadline) {
        toast.info('The run is still going; check its status in the run history.', { id: toastId });
      }
    } catch (e: any) {
      toast.error(e?.message || 'Could not follow the run', { id: toastId });
    } finally {
      if (mounted.current && expanded) loadRuns();
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const res = await api.flows.trigger(projectId, flow.id);
      if (expanded) loadRuns();
      void watchRun(res.runId);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to trigger flow');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: 'Delete flow',
      description: `Delete "${flow.name}"? This cannot be undone.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.flows.remove(projectId, flow.id);
      onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to delete flow');
    } finally {
      setBusy(false);
    }
  };

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) loadRuns();
  };

  const triggerType = flow.trigger?.type ?? 'manual';
  const count = flow.actions?.length ?? 0;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-start gap-3 p-4">
        <button onClick={toggleExpand} className="mt-0.5 text-muted-foreground hover:text-foreground" aria-label="Show runs">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{flow.name}</span>
            <Badge variant="secondary" className="text-xs">
              {TRIGGER_LABELS[triggerType] ?? triggerType}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {count} action{count === 1 ? '' : 's'}
            </span>
          </div>
          <ScheduleLine flow={flow} />
          <WebhookLine projectId={projectId} flow={flow} onChanged={onChanged} onShowSecret={onShowSecret} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2">
            <Switch checked={flow.enabled} onCheckedChange={toggleEnabled} disabled={busy} />
            <span className="text-xs text-muted-foreground">{flow.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <Button size="sm" variant="outline" onClick={run} disabled={busy || !flow.enabled}>
            <Play className="mr-1 h-3.5 w-3.5" /> Run
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy} aria-label="Edit flow">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={busy} aria-label="Delete flow">
            <Trash2 className="h-3.5 w-3.5 text-red-500" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Run history</span>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={loadRuns}>
              <RefreshCw className="mr-1 h-3 w-3" /> Refresh
            </Button>
          </div>
          {runs === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : runs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No runs yet.</div>
          ) : (
            <div className="space-y-1">
              {runs.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setDetailRunId(r.id)}
                  className="flex w-full items-center gap-3 rounded border px-3 py-1.5 text-left text-xs hover:bg-muted/60"
                >
                  <span className={`rounded px-1.5 py-0.5 font-medium ${runStatusClass(r.status)}`}>{r.status}</span>
                  <span className="text-muted-foreground">{formatWhen(r.createdAt)}</span>
                  <span className="text-muted-foreground">{RUN_SOURCE_LABELS[r.source ?? ''] ?? 'API call'}</span>
                  <span className="text-muted-foreground">{formatDuration(runDuration(r))}</span>
                  {r.error && <span className="min-w-0 flex-1 truncate text-right text-red-500">{r.error}</span>}
                </button>
              ))}
              {hasMore && (
                <Button size="sm" variant="outline" className="mt-2 h-7 w-full text-xs" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Load older runs
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <FlowRunDetailsDialog
        projectId={projectId}
        flowId={flow.id}
        runId={detailRunId}
        onOpenChange={(open) => !open && setDetailRunId(null)}
        onRerun={(newRunId) => {
          setDetailRunId(newRunId);
          if (expanded) loadRuns();
        }}
      />
    </div>
  );
}
