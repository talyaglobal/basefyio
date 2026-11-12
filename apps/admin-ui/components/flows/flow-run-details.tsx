'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { FlowRun, FlowStepResult } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CheckCircle2, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { ACTION_LABELS } from './flow-editor-dialog';

export const RUN_SOURCE_LABELS: Record<string, string> = {
  manual: 'Run from the dashboard',
  api: 'API call',
  webhook: 'Webhook',
  schedule: 'Schedule',
  rerun: 'Run again',
};

export function runStatusClass(status: string) {
  switch (status) {
    case 'success':
      return 'bg-green-500/15 text-green-600 dark:text-green-400';
    case 'failed':
      return 'bg-red-500/15 text-red-600 dark:text-red-400';
    case 'running':
      return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** Date and time with the viewer's time zone spelled out. */
export function formatWhen(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZoneName: 'short' });
}

export function formatDuration(ms?: number | null) {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function runDuration(run: FlowRun) {
  if (!run.startedAt || !run.finishedAt) return null;
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

function Json({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono text-[11px]">
      {text ?? 'null'}
    </pre>
  );
}

function Step({ step, position }: { step: FlowStepResult; position: number }) {
  const label = ACTION_LABELS[step.type] ?? step.type;
  return (
    <div className="space-y-2 rounded-md border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {step.ok ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <XCircle className="h-4 w-4 text-red-500" />}
        <span className="font-medium">
          {position}. {step.name ? `${step.name} — ` : ''}
          {label}
        </span>
        {step.status !== undefined && (
          <Badge variant="secondary" className={step.status >= 400 ? 'text-red-600' : ''}>
            HTTP {step.status}
          </Badge>
        )}
        {step.rowCount !== undefined && <Badge variant="secondary">{step.rowCount} row(s)</Badge>}
        {(step.attempts ?? 1) > 1 && <Badge variant="secondary">{step.attempts} attempts</Badge>}
        {step.continued && <Badge variant="secondary">failure ignored</Badge>}
        <span className="ml-auto text-muted-foreground">{formatDuration(step.durationMs)}</span>
      </div>
      {step.detail && (
        <div className={step.ok ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400'}>{step.detail}</div>
      )}
      {step.warnings?.map((w) => (
        <div key={w} className="text-amber-600 dark:text-amber-400">
          {w}
        </div>
      ))}
      {step.attemptLog && step.attemptLog.length > 1 && (
        <div className="space-y-0.5">
          <div className="font-medium text-muted-foreground">Attempts</div>
          {step.attemptLog.map((a) => (
            <div key={a.attempt} className="flex gap-3 font-mono text-[11px]">
              <span>#{a.attempt}</span>
              <span className={a.ok ? 'text-green-600' : 'text-red-600'}>{a.ok ? 'ok' : 'failed'}</span>
              {a.status !== undefined && <span>HTTP {a.status}</span>}
              <span className="text-muted-foreground">{formatDuration(a.durationMs)}</span>
              {a.detail && <span className="truncate text-muted-foreground">{a.detail}</span>}
            </div>
          ))}
        </div>
      )}
      {step.response && (
        <div className="space-y-1">
          {step.response.redirects.length > 0 && (
            <div className="text-muted-foreground">Redirected to: {step.response.redirects.join(' → ')}</div>
          )}
          {Object.keys(step.response.headers).length > 0 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Response headers</summary>
              <Json value={step.response.headers} />
            </details>
          )}
          <div className="text-muted-foreground">
            Response body{step.response.truncated ? ' (truncated)' : ''}
          </div>
          <Json value={step.response.body} />
        </div>
      )}
      {step.rows && step.rows.length > 0 && (
        <div className="space-y-1">
          <div className="text-muted-foreground">
            Rows{step.rowCount && step.rowCount > step.rows.length ? ` (first ${step.rows.length} of ${step.rowCount})` : ''}
          </div>
          <Json value={step.rows} />
        </div>
      )}
    </div>
  );
}

export function FlowRunDetailsDialog({
  projectId,
  flowId,
  runId,
  onOpenChange,
  onRerun,
}: {
  projectId: string;
  flowId: string;
  runId: string | null;
  onOpenChange: (open: boolean) => void;
  onRerun?: (newRunId: string) => void;
}) {
  const [run, setRun] = useState<FlowRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  useEffect(() => {
    if (!runId) {
      setRun(null);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (first: boolean) => {
      if (first) setLoading(true);
      try {
        const r = await api.flows.run(projectId, flowId, runId);
        if (stop) return;
        setRun(r);
        // Keep the view live until the run settles.
        if (r.status === 'queued' || r.status === 'running') timer = setTimeout(() => load(false), 1500);
      } catch (e: any) {
        if (!stop) toast.error(e?.message || 'Could not load the run');
      } finally {
        if (first && !stop) setLoading(false);
      }
    };
    load(true);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, flowId, runId]);

  const rerun = async () => {
    if (!run) return;
    setRerunning(true);
    try {
      const res = await api.flows.rerun(projectId, flowId, run.id);
      toast.success('A new run was started with the same input');
      onRerun?.(res.runId);
    } catch (e: any) {
      toast.error(e?.message || 'Could not start the run');
    } finally {
      setRerunning(false);
    }
  };

  const steps = Array.isArray(run?.result) ? run!.result! : [];
  const meta = (run?.meta ?? {}) as Record<string, any>;

  return (
    <Dialog open={!!runId} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Run details
            {run && <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${runStatusClass(run.status)}`}>{run.status}</span>}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{runId}</DialogDescription>
        </DialogHeader>

        {loading || !run ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">Started by</span>
              <span>{RUN_SOURCE_LABELS[run.source ?? ''] ?? 'API call'}</span>
              <span className="text-muted-foreground">Queued</span>
              <span>{formatWhen(run.createdAt)}</span>
              <span className="text-muted-foreground">Started</span>
              <span>{formatWhen(run.startedAt)}</span>
              <span className="text-muted-foreground">Finished</span>
              <span>{formatWhen(run.finishedAt)}</span>
              <span className="text-muted-foreground">Duration</span>
              <span>{formatDuration(runDuration(run))}</span>
              {meta.scheduledFor && (
                <>
                  <span className="text-muted-foreground">Scheduled for</span>
                  <span>{formatWhen(meta.scheduledFor)}</span>
                </>
              )}
              {run.retryOfId && (
                <>
                  <span className="text-muted-foreground">Repeats run</span>
                  <span className="truncate font-mono">{run.retryOfId}</span>
                </>
              )}
            </div>

            {run.error && <div className="rounded-md bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400">{run.error}</div>}
            {(run.status === 'queued' || run.status === 'running') && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {run.status === 'queued' ? 'Waiting to start…' : 'Running…'}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Steps</div>
              {steps.length === 0 ? (
                <div className="text-xs text-muted-foreground">No step has run yet.</div>
              ) : (
                steps.map((s, i) => <Step key={i} step={s} position={(s.index ?? i) + 1} />)
              )}
            </div>

            <details>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Input</summary>
              <Json value={run.input ?? null} />
            </details>
            {meta.headers && (
              <details>
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Webhook request headers</summary>
                <Json value={meta.headers} />
              </details>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={rerun} disabled={!run || rerunning || run.status === 'queued' || run.status === 'running'}>
            {rerunning ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1 h-4 w-4" />} Run again
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
