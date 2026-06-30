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
} from 'lucide-react';

const TRIGGER_TYPES: FlowTriggerType[] = ['manual', 'webhook', 'schedule'];
const ACTION_TYPES: FlowActionType[] = ['log', 'http.request'];

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

export function ProjectFlows({ projectId }: { projectId: string }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

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
        <Button onClick={() => setCreateOpen(true)}>
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
            <FlowCard key={flow.id} projectId={projectId} flow={flow} onChanged={load} />
          ))}
        </div>
      )}

      <CreateFlowDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={load}
      />
    </div>
  );
}

function FlowCard({
  projectId,
  flow,
  onChanged,
}: {
  projectId: string;
  flow: Flow;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<FlowRun[] | null>(null);

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

  const run = async () => {
    setBusy(true);
    try {
      await api.flows.trigger(projectId, flow.id);
      toast.success('Flow triggered');
      if (expanded) loadRuns();
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

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await api.flows.runs(projectId, flow.id));
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load runs');
    }
  }, [projectId, flow.id]);

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && runs === null) loadRuns();
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-3 p-4">
        <button onClick={toggleExpand} className="text-muted-foreground hover:text-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{flow.name}</span>
            <Badge variant="secondary" className="text-xs">
              {flow.trigger?.type ?? 'manual'}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {flow.actions?.length ?? 0} action{(flow.actions?.length ?? 0) === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch checked={flow.enabled} onCheckedChange={toggleEnabled} disabled={busy} />
            <span className="text-xs text-muted-foreground">{flow.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <Button size="sm" variant="outline" onClick={run} disabled={busy || !flow.enabled}>
            <Play className="mr-1 h-3.5 w-3.5" /> Run
          </Button>
          <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>
            <Trash2 className="h-3.5 w-3.5 text-red-500" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t p-4">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Recent runs</div>
          {runs === null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : runs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No runs yet.</div>
          ) : (
            <div className="space-y-1">
              {runs.map((r) => (
                <div key={r.id} className="flex items-center justify-between rounded border px-3 py-1.5 text-xs">
                  <span className={`rounded px-1.5 py-0.5 font-medium ${statusColor(r.status)}`}>
                    {r.status}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                  {r.error && <span className="max-w-[40%] truncate text-red-500">{r.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CreateFlowDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<FlowTriggerType>('manual');
  const [actions, setActions] = useState<FlowAction[]>([{ type: 'log', message: 'Hello from flow' }]);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName('');
    setTriggerType('manual');
    setActions([{ type: 'log', message: 'Hello from flow' }]);
  };

  const addAction = () => setActions((a) => [...a, { type: 'log', message: '' }]);
  const removeAction = (i: number) => setActions((a) => a.filter((_, idx) => idx !== i));
  const updateAction = (i: number, patch: Partial<FlowAction>) =>
    setActions((a) => a.map((act, idx) => (idx === i ? { ...act, ...patch } : act)));

  const save = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (actions.length === 0) {
      toast.error('Add at least one action');
      return;
    }
    setSaving(true);
    try {
      await api.flows.create(projectId, {
        name: name.trim(),
        trigger: { type: triggerType },
        actions,
        enabled: true,
      });
      toast.success('Flow created');
      reset();
      onOpenChange(false);
      onCreated();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to create flow');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New flow</DialogTitle>
          <DialogDescription>Define a trigger and the actions to run.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="flow-name">Name</Label>
            <Input
              id="flow-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Notify on new order"
            />
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
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Actions</Label>
              <Button size="sm" variant="outline" onClick={addAction}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add
              </Button>
            </div>
            {actions.map((action, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Select
                    value={action.type}
                    onValueChange={(v) => updateAction(i, { type: v as FlowActionType })}
                  >
                    <SelectTrigger className="h-8 w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTION_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => removeAction(i)}>
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
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
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
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
