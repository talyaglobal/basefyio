'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import type { Flow, FlowAction, FlowRun, FlowActionType, FlowTriggerType } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Play,
  Plus,
  Trash2,
  Workflow,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Copy,
  KeyRound,
} from 'lucide-react';
import { formatDateTime } from '@/lib/format';

const TRIGGER_TYPES: FlowTriggerType[] = ['manual', 'webhook', 'schedule'];
const ACTION_TYPES: FlowActionType[] = ['log', 'http.request'];
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

const TRIGGER_LABEL: Record<FlowTriggerType, string> = {
  manual: 'Manual (Run button or API)',
  webhook: 'Webhook (signed HTTP call)',
  schedule: 'Schedule (cron)',
};
const TRIGGER_BADGE: Record<FlowTriggerType, string> = { manual: 'Manual', webhook: 'Webhook', schedule: 'Schedule' };
const ACTION_LABEL: Record<FlowActionType, string> = { log: 'Write a log line', 'http.request': 'Send an HTTP request' };

const CRON_EXAMPLES: { cron: string; label: string }[] = [
  { cron: '*/15 * * * *', label: 'every 15 minutes' },
  { cron: '0 * * * *', label: 'every hour' },
  { cron: '0 9 * * 1-5', label: 'weekdays at 09:00' },
  { cron: '0 0 * * *', label: 'every day at midnight' },
];

/** A fresh action of a type: switching type never carries the old fields along (#23). */
function blankAction(type: FlowActionType): FlowAction {
  return type === 'log' ? { type: 'log', message: '' } : { type: 'http.request', method: 'POST', url: '' };
}

function statusColor(status: string) {
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

/** The signed public endpoint of a webhook flow, from the project's REST base URL. */
function webhookUrlFor(restUrl: string | null, flowId: string): string | null {
  if (!restUrl) return null;
  return `${restUrl.replace(/\/rest\/v1\/?$/, '')}/webhooks/flows/${flowId}`;
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('Could not copy');
  }
}

export function ProjectFlows({ projectId }: { projectId: string }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Flow | 'new' | null>(null);
  const [restUrl, setRestUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ flowId: string; secret: string } | null>(null);

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
    api.projects
      .connect(projectId)
      .then((c: any) => setRestUrl(c?.restUrl ?? null))
      .catch(() => setRestUrl(null));
  }, [load, projectId]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Workflow className="h-5 w-5 text-primary" /> Flows
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Automate work with triggers and actions. A flow runs its actions in order when triggered.
          </p>
        </div>
        <Button onClick={() => setEditing('new')} data-tour="project-flows-new">
          <Plus className="mr-1 h-4 w-4" /> New flow
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : flows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground" data-tour="project-flows-list">
          No flows yet. Create your first automation.
        </div>
      ) : (
        <div className="space-y-3">
          {flows.map((flow, index) => (
            <FlowCard
              key={flow.id}
              tourAnchors={index === 0}
              projectId={projectId}
              flow={flow}
              webhookUrl={webhookUrlFor(restUrl, flow.id)}
              onEdit={() => setEditing(flow)}
              onSecret={(s) => setSecret({ flowId: flow.id, secret: s })}
              onChanged={load}
            />
          ))}
        </div>
      )}

      <FlowDialog
        key={editing === 'new' ? 'new' : editing?.id ?? 'closed'}
        open={editing !== null}
        flow={editing === 'new' ? null : editing}
        onOpenChange={(v) => !v && setEditing(null)}
        projectId={projectId}
        onSaved={(saved) => {
          setEditing(null);
          load();
          if (saved?.webhookSecret) setSecret({ flowId: saved.id, secret: saved.webhookSecret });
        }}
      />

      <Dialog open={secret !== null} onOpenChange={(v) => !v && setSecret(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Webhook secret</DialogTitle>
            <DialogDescription>
              Shown once. Store it now: it signs every call to this flow and cannot be read again (rotate it to get a new one).
            </DialogDescription>
          </DialogHeader>
          {secret && <WebhookHowTo url={webhookUrlFor(restUrl, secret.flowId)} secret={secret.secret} />}
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>I stored it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WebhookHowTo({ url, secret }: { url: string | null; secret?: string }) {
  const sample = `BODY='{"orderId":42}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
curl -X POST "${url ?? '<webhook URL>'}" \\
  -H "Content-Type: application/json" \\
  -H "x-basefyio-signature: $SIG" \\
  -d "$BODY"`;
  return (
    <div className="space-y-2 text-xs">
      {url && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1">{url}</code>
          <Button size="sm" variant="outline" onClick={() => void copy(url, 'URL')} aria-label="Copy webhook URL">
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {secret && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1">{secret}</code>
          <Button size="sm" variant="outline" onClick={() => void copy(secret, 'Secret')} aria-label="Copy webhook secret">
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <p className="text-muted-foreground">
        Send a POST with the header <code>x-basefyio-signature: sha256=&lt;HMAC-SHA256 of the raw body, hex&gt;</code>. The
        JSON body becomes the run&apos;s input.
      </p>
      <pre className="overflow-x-auto rounded bg-muted p-2 text-[11px]">{sample}</pre>
    </div>
  );
}

function FlowCard({
  projectId,
  flow,
  webhookUrl,
  onEdit,
  onSecret,
  onChanged,
  tourAnchors,
}: {
  projectId: string;
  tourAnchors?: boolean;
  flow: Flow;
  webhookUrl: string | null;
  onEdit: () => void;
  onSecret: (secret: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<FlowRun[] | null>(null);
  const triggerType = (flow.trigger?.type ?? 'manual') as FlowTriggerType;
  const nextRunAt = (flow as Flow & { nextRunAt?: string | null }).nextRunAt ?? null;

  const loadRuns = useCallback(async () => {
    try {
      const list = await api.flows.runs(projectId, flow.id);
      setRuns(list);
      return list;
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load runs');
      return null;
    }
  }, [projectId, flow.id]);

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

  /** Queue a run, then report how it ended instead of "triggered" (#23). */
  const run = async () => {
    setBusy(true);
    try {
      const queued = await api.flows.trigger(projectId, flow.id);
      setExpanded(true);
      const runId = queued?.runId;
      let finished: FlowRun | undefined;
      for (let i = 0; runId && i < 15; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const list = await loadRuns();
        finished = list?.find((r) => r.id === runId && (r.status === 'success' || r.status === 'failed'));
        if (finished) break;
      }
      if (!finished) toast.message('Run queued and still running. Its result appears under Recent runs.');
      else if (finished.status === 'success') toast.success('Run succeeded');
      else toast.error(`Run failed${finished.error ? `: ${finished.error}` : ''}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to run flow');
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

  const rotate = async () => {
    const ok = await confirmDialog({
      title: 'Rotate webhook secret',
      description: 'Callers using the current secret are refused from now on. The new secret is shown once.',
      confirmText: 'Rotate',
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.flows.rotateWebhookSecret(projectId, flow.id);
      onSecret(r.webhookSecret);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to rotate the secret');
    }
  };

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && runs === null) void loadRuns();
  };

  return (
    <div className="rounded-lg border bg-card" data-tour={tourAnchors ? 'project-flows-list' : undefined}>
      <div className="flex flex-wrap items-center gap-3 p-4">
        <button
          onClick={toggleExpand}
          className="text-muted-foreground hover:text-foreground"
          data-tour={tourAnchors ? 'project-flows-runs' : undefined}
          aria-label={expanded ? `Hide details of ${flow.name}` : `Show details of ${flow.name}`}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{flow.name}</span>
            <Badge variant="secondary" className="text-xs">
              {TRIGGER_BADGE[triggerType] ?? triggerType}
            </Badge>
            {triggerType === 'schedule' && flow.trigger?.cron && (
              <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{flow.trigger.cron}</code>
            )}
            <span className="text-xs text-muted-foreground">
              {flow.actions?.length ?? 0} action{(flow.actions?.length ?? 0) === 1 ? '' : 's'}
            </span>
          </div>
          {triggerType === 'schedule' && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {flow.enabled && nextRunAt ? `Next run ${formatDateTime(nextRunAt)} (cron in UTC)` : 'Not scheduled while disabled'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2" data-tour={tourAnchors ? 'project-flows-enabled' : undefined}>
            <Switch checked={flow.enabled} onCheckedChange={toggleEnabled} disabled={busy} aria-label="Flow enabled" />
            <span className="text-xs text-muted-foreground">{flow.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <Button size="sm" variant="outline" onClick={run} disabled={busy || !flow.enabled} data-tour={tourAnchors ? 'project-flows-run' : undefined}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />} Run
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy} aria-label={`Edit ${flow.name}`}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={busy} aria-label={`Delete ${flow.name}`}>
            <Trash2 className="h-3.5 w-3.5 text-red-500" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t p-4">
          {triggerType === 'webhook' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-muted-foreground">Webhook</div>
                <Button size="sm" variant="outline" onClick={rotate}>
                  <KeyRound className="mr-1 h-3.5 w-3.5" /> Rotate secret
                </Button>
              </div>
              <WebhookHowTo url={webhookUrl} />
            </div>
          )}
          <div>
            <div className="mb-2 text-xs font-medium text-muted-foreground">Recent runs</div>
            {runs === null ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : runs.length === 0 ? (
              <div className="text-sm text-muted-foreground">No runs yet.</div>
            ) : (
              <div className="space-y-1">
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One run, with each action's outcome (HTTP status included) when opened. */
function RunRow({ run }: { run: FlowRun }) {
  const [open, setOpen] = useState(false);
  const steps = Array.isArray(run.result)
    ? (run.result as Array<{ type?: string; ok?: boolean; status?: number; detail?: string }>)
    : [];
  return (
    <div className="rounded border text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
      >
        <span className={`rounded px-1.5 py-0.5 font-medium ${statusColor(run.status)}`}>{run.status}</span>
        <span className="text-muted-foreground">{formatDateTime(run.createdAt)}</span>
        {run.error ? <span className="max-w-[45%] truncate text-red-500">{run.error}</span> : <span />}
      </button>
      {open && (
        <div className="space-y-1 border-t px-3 py-2">
          {steps.length === 0 && !run.error && <p className="text-muted-foreground">No step details recorded.</p>}
          {steps.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className={s.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                {s.ok ? 'OK' : 'Failed'}
              </span>
              <span>{s.type ? ACTION_LABEL[s.type as FlowActionType] ?? s.type : `Step ${i + 1}`}</span>
              {typeof s.status === 'number' && <code className="rounded bg-muted px-1">HTTP {s.status}</code>}
              {s.detail && <span className="text-muted-foreground">{s.detail}</span>}
            </div>
          ))}
          {run.error && <p className="text-red-500">{run.error}</p>}
          {run.input != null && (
            <pre className="max-h-32 overflow-auto rounded bg-muted p-1.5 text-[11px]">{JSON.stringify(run.input, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

/** Client checks mirroring the server's, so mistakes show inline before saving. */
function problemsOf(name: string, triggerType: FlowTriggerType, cron: string, actions: FlowAction[]) {
  const out: { name?: string; cron?: string; actions: Record<number, string> } = { actions: {} };
  if (!name.trim()) out.name = 'Give the flow a name.';
  if (triggerType === 'schedule' && cron.trim().split(/\s+/).filter(Boolean).length !== 5) {
    out.cron = 'Enter a 5-field cron expression, e.g. */15 * * * *.';
  }
  actions.forEach((a, i) => {
    if (a.type === 'log' && !a.message?.trim()) out.actions[i] = 'Enter the message to log.';
    if (a.type === 'http.request' && !/^https?:\/\/\S+$/i.test(a.url?.trim() ?? '')) out.actions[i] = 'Enter an http(s) URL.';
  });
  return out;
}

function FlowDialog({
  open,
  flow,
  onOpenChange,
  projectId,
  onSaved,
}: {
  open: boolean;
  flow: Flow | null;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  onSaved: (saved: (Flow & { webhookSecret?: string }) | null) => void;
}) {
  const [name, setName] = useState(flow?.name ?? '');
  const [triggerType, setTriggerType] = useState<FlowTriggerType>((flow?.trigger?.type as FlowTriggerType) ?? 'manual');
  const [cron, setCron] = useState(flow?.trigger?.cron ?? '');
  const [actions, setActions] = useState<FlowAction[]>(
    flow?.actions?.length ? flow.actions.map((a) => ({ ...a })) : [{ type: 'log', message: 'Hello from flow' }],
  );
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  const problems = problemsOf(name, triggerType, cron, actions);
  const hasProblems =
    !!problems.name || !!problems.cron || Object.keys(problems.actions).length > 0 || actions.length === 0;

  const addAction = () => setActions((a) => [...a, blankAction('log')]);
  const removeAction = (i: number) => setActions((a) => a.filter((_, idx) => idx !== i));
  const updateAction = (i: number, patch: Partial<FlowAction>) =>
    setActions((a) => a.map((act, idx) => (idx === i ? { ...act, ...patch } : act)));
  const changeActionType = (i: number, type: FlowActionType) =>
    setActions((a) => a.map((act, idx) => (idx === i ? (act.type === type ? act : blankAction(type)) : act)));

  const save = async () => {
    setTouched(true);
    if (hasProblems) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        trigger: triggerType === 'schedule' ? { type: triggerType, cron: cron.trim() } : { type: triggerType },
        actions,
        enabled: flow?.enabled ?? true,
      };
      const saved = flow ? await api.flows.update(projectId, flow.id, body) : await api.flows.create(projectId, body);
      toast.success(flow ? 'Flow saved' : 'Flow created');
      onSaved(saved as Flow & { webhookSecret?: string });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save flow');
    } finally {
      setSaving(false);
    }
  };

  const err = (msg?: string) => (touched && msg ? <p className="text-xs text-red-600">{msg}</p> : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{flow ? `Edit ${flow.name}` : 'New flow'}</DialogTitle>
          <DialogDescription>Define a trigger and the actions to run, in order.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="flow-name">Name</Label>
            <Input id="flow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Notify on new order" />
            {err(problems.name)}
          </div>

          <div className="space-y-1.5">
            <Label>Trigger</Label>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as FlowTriggerType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {triggerType === 'schedule' && (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="flow-cron">Cron expression (UTC)</Label>
                <Input
                  id="flow-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  placeholder="*/15 * * * *"
                  className="font-mono"
                />
                <div className="flex flex-wrap gap-1.5">
                  {CRON_EXAMPLES.map((ex) => (
                    <button
                      key={ex.cron}
                      type="button"
                      onClick={() => setCron(ex.cron)}
                      className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                    >
                      {ex.label}
                    </button>
                  ))}
                </div>
                {err(problems.cron)}
              </div>
            )}
            {triggerType === 'webhook' && (
              <p className="text-xs text-muted-foreground">
                After saving you get the flow&apos;s URL and a secret. Calls must be signed with the secret (HMAC-SHA256).
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Actions</Label>
              <Button size="sm" variant="outline" onClick={addAction}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add
              </Button>
            </div>
            {touched && actions.length === 0 && <p className="text-xs text-red-600">Add at least one action.</p>}
            {actions.map((action, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Select value={action.type} onValueChange={(v) => changeActionType(i, v as FlowActionType)}>
                    <SelectTrigger className="h-8 w-52">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTION_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {ACTION_LABEL[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => removeAction(i)} aria-label={`Remove action ${i + 1}`}>
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </div>

                {action.type === 'log' && (
                  <Input
                    value={action.message ?? ''}
                    onChange={(e) => updateAction(i, { message: e.target.value })}
                    placeholder="Message to log"
                  />
                )}

                {action.type === 'http.request' && (
                  <div className="flex gap-2">
                    <Select
                      value={action.method ?? 'POST'}
                      onValueChange={(v) => updateAction(i, { method: v as FlowAction['method'] })}
                    >
                      <SelectTrigger className="h-9 w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HTTP_METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={action.url ?? ''}
                      onChange={(e) => updateAction(i, { url: e.target.value })}
                      placeholder="https://example.com/webhook"
                    />
                  </div>
                )}
                {err(problems.actions[i])}
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} {flow ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
