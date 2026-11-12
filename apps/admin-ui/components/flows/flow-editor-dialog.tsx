'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type {
  Flow,
  FlowAction,
  FlowActionType,
  FlowHttpMethod,
  FlowInput,
  FlowOptions,
  FlowTriggerType,
} from '@/lib/types';
import { CRON_PRESETS, cronError, describeCron, isValidTimeZone, nextRuns } from '@/lib/flow-cron';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from 'lucide-react';

export const TRIGGER_LABELS: Record<FlowTriggerType, string> = {
  manual: 'Manual',
  webhook: 'Webhook',
  schedule: 'Schedule',
};

const TRIGGER_HINTS: Record<FlowTriggerType, string> = {
  manual: 'Runs when you press Run, or when your server calls the trigger endpoint with the service key.',
  webhook: 'Gets its own URL and secret, so an outside system (GitHub, Stripe, a form) can start it without your service key.',
  schedule: 'Runs on a cron schedule, at most once a minute.',
};

export const ACTION_LABELS: Record<FlowActionType, string> = {
  log: 'Log a message',
  'http.request': 'HTTP request',
  'db.select': 'Read rows',
  'db.insert': 'Insert rows',
  'db.update': 'Update rows',
};

const ACTION_TYPES: FlowActionType[] = ['log', 'http.request', 'db.select', 'db.insert', 'db.update'];
const METHODS: FlowHttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const MASKED = '********';

interface Pair {
  k: string;
  v: string;
}

/** An action as the form edits it; turned into a FlowAction on save. */
interface DraftAction {
  key: string;
  id?: string;
  type: FlowActionType;
  name: string;
  message: string;
  method: FlowHttpMethod;
  url: string;
  headers: Pair[];
  body: string;
  followRedirects: boolean;
  table: string;
  filters: Pair[];
  select: string;
  limit: string;
  values: string;
  timeoutSec: string;
  retries: string;
  retryDelaySec: string;
  continueOnError: boolean;
  advanced: boolean;
}

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

function blankAction(type: FlowActionType, keep?: Pick<DraftAction, 'key' | 'id' | 'name'>): DraftAction {
  return {
    key: keep?.key ?? nextKey(),
    id: keep?.id,
    name: keep?.name ?? '',
    type,
    message: '',
    method: type === 'http.request' ? 'POST' : 'GET',
    url: '',
    headers: [],
    body: '',
    followRedirects: true,
    table: '',
    filters: [],
    select: '',
    limit: '',
    values: type === 'db.insert' || type === 'db.update' ? '{\n  \n}' : '',
    timeoutSec: '',
    retries: '',
    retryDelaySec: '',
    continueOnError: false,
    advanced: false,
  };
}

const toPairs = (o?: Record<string, string>): Pair[] => Object.entries(o ?? {}).map(([k, v]) => ({ k, v: String(v) }));
const secStr = (ms?: number) => (ms === undefined || ms === null ? '' : String(ms / 1000));
const pretty = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function fromAction(a: FlowAction): DraftAction {
  const d = blankAction(a.type, { key: nextKey(), id: a.id, name: a.name ?? '' });
  return {
    ...d,
    message: a.message ?? '',
    method: (a.method as FlowHttpMethod) ?? (a.type === 'http.request' ? 'POST' : 'GET'),
    url: a.url ?? '',
    headers: toPairs(a.headers),
    body: pretty(a.body),
    followRedirects: a.followRedirects !== false,
    table: a.table ?? '',
    filters: toPairs(a.filters),
    select: a.select ?? '',
    limit: a.limit ? String(a.limit) : '',
    values: a.values !== undefined ? pretty(a.values) : d.values,
    timeoutSec: secStr(a.timeoutMs),
    retries: a.retries !== undefined ? String(a.retries) : '',
    retryDelaySec: secStr(a.retryDelayMs),
    continueOnError: !!a.continueOnError,
    advanced: !!(a.name || a.timeoutMs || a.retries || a.retryDelayMs || a.continueOnError || a.followRedirects === false),
  };
}

interface Template {
  label: string;
  description: string;
  name: string;
  trigger: FlowTriggerType;
  cron?: string;
  actions: FlowAction[];
}

const TEMPLATES: Template[] = [
  {
    label: 'Health check',
    description: 'Call a URL every 15 minutes, retrying twice',
    name: 'Health check',
    trigger: 'schedule',
    cron: '*/15 * * * *',
    actions: [{ type: 'http.request', method: 'GET', url: 'https://example.com/health', retries: 2 }],
  },
  {
    label: 'Webhook to chat',
    description: 'Forward an incoming webhook to a chat or notification URL',
    name: 'Forward webhook',
    trigger: 'webhook',
    actions: [
      {
        type: 'http.request',
        method: 'POST',
        url: 'https://hooks.example.com/notify',
        body: { text: 'New event: {{input.event}} at {{now}}' },
      },
    ],
  },
  {
    label: 'Save webhook to a table',
    description: 'Store every webhook payload as a row',
    name: 'Store webhook events',
    trigger: 'webhook',
    actions: [{ type: 'db.insert', table: 'webhook_events', values: { payload: '{{input}}', received_at: '{{now}}' } }],
  },
  {
    label: 'Daily summary',
    description: 'Read recent rows every morning and post them',
    name: 'Daily summary',
    trigger: 'schedule',
    cron: '0 9 * * *',
    actions: [
      { type: 'db.select', name: 'orders', table: 'orders', filters: { status: 'eq.new' }, limit: 50 },
      {
        type: 'http.request',
        method: 'POST',
        url: 'https://hooks.example.com/report',
        body: { count: '{{steps.orders.rowCount}}', orders: '{{steps.orders.rows}}' },
      },
    ],
  },
];

type Errors = Record<string, string>;

function numberIn(raw: string, min: number, max: number, label: string, errors: Errors, key: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors[key] = `${label} must be between ${min} and ${max}`;
    return undefined;
  }
  return n;
}

function pairsToRecord(pairs: Pair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.k.trim()) out[p.k.trim()] = p.v;
  return Object.keys(out).length ? out : undefined;
}

/** Build the API payload; returns field errors instead when the form is not valid. */
function buildPayload(state: {
  name: string;
  triggerType: FlowTriggerType;
  cron: string;
  timezone: string;
  actions: DraftAction[];
  limits: { timeoutSec: string; retries: string; maxDurationSec: string; maxConcurrentRuns: string };
}): { payload?: FlowInput; errors: Errors } {
  const errors: Errors = {};
  if (!state.name.trim()) errors.name = 'Give the flow a name';
  const trigger: FlowInput['trigger'] = { type: state.triggerType };
  if (state.triggerType === 'schedule') {
    const err = cronError(state.cron);
    if (err) errors.cron = err;
    trigger.cron = state.cron.trim();
    if (state.timezone && state.timezone !== 'UTC') {
      if (!isValidTimeZone(state.timezone)) errors.timezone = 'Unknown time zone (example: Europe/Istanbul)';
      trigger.timezone = state.timezone;
    }
  }
  if (state.actions.length === 0) errors.actions = 'Add at least one action';

  const names = new Set<string>();
  const actions: FlowAction[] = state.actions.map((d, i) => {
    const at = (f: string) => `a${i}.${f}`;
    const a: FlowAction = { type: d.type };
    if (d.id) a.id = d.id;
    if (d.name.trim()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,59}$/.test(d.name.trim())) errors[at('name')] = 'Letters, digits and _ only; start with a letter';
      else if (names.has(d.name.trim())) errors[at('name')] = 'Step names must be unique';
      names.add(d.name.trim());
      a.name = d.name.trim();
    }
    if (d.type === 'log') {
      if (!d.message.trim()) errors[at('message')] = 'Enter the message to log';
      a.message = d.message.trim();
    }
    if (d.type === 'http.request') {
      const url = d.url.trim();
      if (!url) errors[at('url')] = 'Enter the URL to call';
      else if (!/^https?:\/\//i.test(url) && !url.startsWith('{{')) errors[at('url')] = 'The URL must start with http:// or https://';
      a.url = url;
      a.method = d.method;
      const headers = pairsToRecord(d.headers);
      if (headers) a.headers = headers;
      const bodyText = d.body.trim();
      if (bodyText) {
        if (d.method === 'GET' || d.method === 'HEAD') errors[at('body')] = `A ${d.method} request cannot have a body`;
        else if (/^[[{]/.test(bodyText)) {
          try {
            a.body = JSON.parse(bodyText);
          } catch {
            errors[at('body')] = 'The body looks like JSON but does not parse';
          }
        } else a.body = bodyText;
      }
      if (!d.followRedirects) a.followRedirects = false;
    }
    if (d.type === 'db.select' || d.type === 'db.insert' || d.type === 'db.update') {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(d.table.trim())) errors[at('table')] = 'Enter a table name';
      a.table = d.table.trim();
      const filters = pairsToRecord(d.filters);
      if (filters) {
        for (const [k, v] of Object.entries(filters)) {
          if (!/^(not\.)?[a-z]+\./.test(v.trim())) errors[at('filters')] = `Filter "${k}" needs an operator, e.g. eq.42`;
        }
      }
      if (d.type === 'db.select') {
        if (filters) a.filters = filters;
        if (d.select.trim()) a.select = d.select.trim();
        const limit = numberIn(d.limit, 1, 1000, 'Row limit', errors, at('limit'));
        if (limit !== undefined) a.limit = Math.round(limit);
      } else {
        try {
          const parsed = JSON.parse(d.values || 'null');
          const isRow = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0;
          const ok = isRow(parsed) || (d.type === 'db.insert' && Array.isArray(parsed) && parsed.length > 0 && parsed.every(isRow));
          if (!ok) errors[at('values')] = d.type === 'db.insert' ? 'Enter a row object (or a list of rows)' : 'Enter the columns to change';
          a.values = parsed;
        } catch {
          errors[at('values')] = 'Values must be valid JSON';
        }
        if (d.type === 'db.update') {
          if (!filters) errors[at('filters')] = 'Add at least one filter so the update cannot change every row';
          a.filters = filters;
        }
      }
    }
    if (d.type !== 'log') {
      const t = numberIn(d.timeoutSec, 1, 30, 'Timeout', errors, at('timeout'));
      if (t !== undefined) a.timeoutMs = Math.round(t * 1000);
    }
    const r = numberIn(d.retries, 0, 5, 'Retries', errors, at('retries'));
    if (r !== undefined) a.retries = Math.round(r);
    const rd = numberIn(d.retryDelaySec, 0, 60, 'Retry delay', errors, at('retryDelay'));
    if (rd !== undefined) a.retryDelayMs = Math.round(rd * 1000);
    if (d.continueOnError) a.continueOnError = true;
    return a;
  });

  const options: FlowOptions = {};
  const t = numberIn(state.limits.timeoutSec, 1, 30, 'Step timeout', errors, 'opt.timeout');
  if (t !== undefined) options.timeoutMs = Math.round(t * 1000);
  const r = numberIn(state.limits.retries, 0, 5, 'Retries', errors, 'opt.retries');
  if (r !== undefined) options.retries = Math.round(r);
  const md = numberIn(state.limits.maxDurationSec, 10, 900, 'Run time limit', errors, 'opt.maxDuration');
  if (md !== undefined) options.maxDurationMs = Math.round(md * 1000);
  const mc = numberIn(state.limits.maxConcurrentRuns, 1, 20, 'Concurrent runs', errors, 'opt.maxConcurrent');
  if (mc !== undefined) options.maxConcurrentRuns = Math.round(mc);

  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    payload: {
      name: state.name.trim(),
      trigger,
      actions,
      options: Object.keys(options).length ? options : null,
    },
  };
}

/** Map an API error such as "actions[1].url is required…" onto the form. */
function serverErrorKey(message: string): string | null {
  const m = message.match(/actions\[(\d+)\]\.(\w+)/);
  if (m) {
    const field = { timeoutMs: 'timeout', retryDelayMs: 'retryDelay' }[m[2]] ?? m[2];
    return `a${m[1]}.${field}`;
  }
  if (/trigger\.cron/.test(message)) return 'cron';
  if (/trigger\.timezone/.test(message)) return 'timezone';
  if (/^name /.test(message)) return 'name';
  return null;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-red-500">{message}</p>;
}

function PairsEditor({
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  maskedHint,
}: {
  pairs: Pair[];
  onChange: (p: Pair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  maskedHint?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {pairs.map((p, i) => (
        <div key={i} className="flex gap-2">
          <Input
            className="h-8 w-2/5 font-mono text-xs"
            value={p.k}
            placeholder={keyPlaceholder}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
          />
          <Input
            className="h-8 flex-1 font-mono text-xs"
            value={p.v}
            placeholder={valuePlaceholder}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          <Button size="sm" variant="ghost" className="h-8" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {maskedHint && pairs.some((p) => p.v === MASKED) && (
        <p className="text-xs text-muted-foreground">
          {MASKED} is a saved secret value kept hidden. Leave it as is to keep it, or type a new value.
        </p>
      )}
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onChange([...pairs, { k: '', v: '' }])}>
        <Plus className="mr-1 h-3 w-3" /> Add
      </Button>
    </div>
  );
}

export function FlowEditorDialog({
  open,
  onOpenChange,
  projectId,
  flow,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  /** set = edit this flow; unset = create a new one */
  flow?: Flow | null;
  onSaved: (flow: Flow) => void;
}) {
  const editing = !!flow;
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState<FlowTriggerType>('manual');
  const [cron, setCron] = useState('*/15 * * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [actions, setActions] = useState<DraftAction[]>([]);
  const [limits, setLimits] = useState({ timeoutSec: '', retries: '', maxDurationSec: '', maxConcurrentRuns: '' });
  const [showLimits, setShowLimits] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const browserTz = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setFormError('');
    if (flow) {
      setName(flow.name);
      setTriggerType(flow.trigger?.type ?? 'manual');
      setCron(flow.trigger?.cron ?? '*/15 * * * *');
      setTimezone(flow.trigger?.timezone ?? 'UTC');
      setActions((flow.actions ?? []).map(fromAction));
      const o = flow.options ?? {};
      setLimits({
        timeoutSec: secStr(o.timeoutMs),
        retries: o.retries !== undefined ? String(o.retries) : '',
        maxDurationSec: secStr(o.maxDurationMs),
        maxConcurrentRuns: o.maxConcurrentRuns ? String(o.maxConcurrentRuns) : '',
      });
      setShowLimits(!!(o.timeoutMs || o.retries || o.maxDurationMs || o.maxConcurrentRuns));
    } else {
      setName('');
      setTriggerType('manual');
      setCron('*/15 * * * *');
      setTimezone('UTC');
      setActions([{ ...blankAction('log'), message: 'Hello from my flow' }]);
      setLimits({ timeoutSec: '', retries: '', maxDurationSec: '', maxConcurrentRuns: '' });
      setShowLimits(false);
    }
  }, [open, flow]);

  const applyTemplate = (t: Template) => {
    setName(t.name);
    setTriggerType(t.trigger);
    if (t.cron) setCron(t.cron);
    setActions(t.actions.map(fromAction));
    setErrors({});
    setFormError('');
  };

  const update = (i: number, patch: Partial<DraftAction>) =>
    setActions((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  // A new type starts from a clean slate, so nothing from the old type is saved.
  const changeType = (i: number, type: FlowActionType) =>
    setActions((list) => list.map((a, j) => (j === i ? { ...blankAction(type, a), advanced: a.advanced } : a)));
  const move = (i: number, by: number) =>
    setActions((list) => {
      const j = i + by;
      if (j < 0 || j >= list.length) return list;
      const copy = [...list];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const cronProblem = triggerType === 'schedule' ? cronError(cron) : null;
  const cronText = triggerType === 'schedule' && !cronProblem ? describeCron(cron) : '';
  const tzOk = !timezone || timezone === 'UTC' || isValidTimeZone(timezone);
  const upcoming = triggerType === 'schedule' && !cronProblem && tzOk ? nextRuns(cron, 3, timezone || 'UTC') : [];

  const save = async () => {
    const { payload, errors: errs } = buildPayload({ name, triggerType, cron, timezone, actions, limits });
    setErrors(errs);
    setFormError('');
    if (!payload) {
      if (errs['opt.timeout'] || errs['opt.retries'] || errs['opt.maxDuration'] || errs['opt.maxConcurrent']) setShowLimits(true);
      setActions((list) => list.map((a, i) => (Object.keys(errs).some((k) => k.startsWith(`a${i}.`) && /name|timeout|retries|retryDelay/.test(k)) ? { ...a, advanced: true } : a)));
      return;
    }
    setSaving(true);
    try {
      const saved = editing
        ? await api.flows.update(projectId, (flow as Flow).id, payload)
        : await api.flows.create(projectId, { ...payload, enabled: true });
      toast.success(editing ? 'Flow saved' : 'Flow created');
      onOpenChange(false);
      onSaved(saved);
    } catch (e: any) {
      const message = String(e?.message || 'Could not save the flow');
      const key = serverErrorKey(message);
      if (key) setErrors({ [key]: message });
      else setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit flow' : 'New flow'}</DialogTitle>
          <DialogDescription>Choose what starts the flow and the steps it runs, in order.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {!editing && (
            <div className="space-y-1.5">
              <Label>Start from a template</Label>
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className="rounded-md border p-2 text-left text-xs hover:bg-muted"
                  >
                    <div className="font-medium">{t.label}</div>
                    <div className="text-muted-foreground">{t.description}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="flow-name">Name</Label>
            <Input id="flow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Notify on new order" />
            <FieldError message={errors.name} />
          </div>

          <div className="space-y-2">
            <Label>Trigger</Label>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as FlowTriggerType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TRIGGER_LABELS) as FlowTriggerType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{TRIGGER_HINTS[triggerType]}</p>

            {triggerType === 'schedule' && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex flex-wrap gap-1.5">
                  {CRON_PRESETS.map((p) => (
                    <button
                      key={p.cron}
                      type="button"
                      onClick={() => setCron(p.cron)}
                      className={`rounded border px-2 py-0.5 text-xs hover:bg-muted ${cron === p.cron ? 'border-primary text-primary' : ''}`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2 space-y-1">
                    <Label htmlFor="flow-cron" className="text-xs">
                      Cron expression (minute hour day month weekday)
                    </Label>
                    <Input id="flow-cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/15 * * * *" />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="flow-tz" className="text-xs">
                      Time zone
                    </Label>
                    <Input id="flow-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC" />
                  </div>
                </div>
                {timezone !== browserTz && (
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => setTimezone(browserTz)}>
                    Use my time zone ({browserTz})
                  </button>
                )}
                <FieldError message={errors.cron || cronProblem || undefined} />
                <FieldError message={errors.timezone || (!tzOk ? 'Unknown time zone (example: Europe/Istanbul)' : undefined)} />
                {cronText && (
                  <div className="text-xs">
                    <span className="font-medium">{cronText}</span>
                    <span className="text-muted-foreground"> ({timezone || 'UTC'})</span>
                    {upcoming.length > 0 && (
                      <div className="mt-1 text-muted-foreground">
                        Next runs:{' '}
                        {upcoming
                          .map((d) => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZoneName: 'short' }))
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {triggerType === 'webhook' && (
              <div className="rounded-md border p-3 text-xs text-muted-foreground">
                {editing && flow?.webhookUrl ? (
                  <>
                    Webhook URL: <code className="break-all font-mono">{flow.webhookUrl}</code>. Manage its secret from the flow card.
                  </>
                ) : (
                  <>A unique URL and secret are created when you save. The secret is shown once; you can reveal or rotate it later.</>
                )}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Actions</Label>
              <Button size="sm" variant="outline" onClick={() => setActions((a) => [...a, blankAction('http.request')])}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Add action
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use <code className="font-mono">{'{{input.field}}'}</code> for the run input,{' '}
              <code className="font-mono">{'{{steps.0.body.id}}'}</code> or <code className="font-mono">{'{{steps.name.status}}'}</code>{' '}
              for an earlier step, and <code className="font-mono">{'{{now}}'}</code> for the run time.
            </p>
            <FieldError message={errors.actions} />

            {actions.map((a, i) => {
              const at = (f: string) => errors[`a${i}.${f}`];
              return (
                <div key={a.key} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span>
                    <Select value={a.type} onValueChange={(v) => changeType(i, v as FlowActionType)}>
                      <SelectTrigger className="h-8 w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACTION_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {ACTION_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex-1" />
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => move(i, 1)} disabled={i === actions.length - 1} aria-label="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setActions((l) => l.filter((_, j) => j !== i))} aria-label="Remove action">
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  </div>

                  {a.type === 'log' && (
                    <>
                      <Input value={a.message} onChange={(e) => update(i, { message: e.target.value })} placeholder="Order {{input.id}} received" />
                      <FieldError message={at('message')} />
                    </>
                  )}

                  {a.type === 'http.request' && (
                    <>
                      <div className="flex gap-2">
                        <Select value={a.method} onValueChange={(v) => update(i, { method: v as FlowHttpMethod })}>
                          <SelectTrigger className="h-9 w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {METHODS.map((m) => (
                              <SelectItem key={m} value={m}>
                                {m}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input value={a.url} onChange={(e) => update(i, { url: e.target.value })} placeholder="https://example.com/webhook" />
                      </div>
                      <FieldError message={at('url') || at('method')} />
                      <div className="space-y-1">
                        <Label className="text-xs">Headers</Label>
                        <PairsEditor
                          pairs={a.headers}
                          onChange={(headers) => update(i, { headers })}
                          keyPlaceholder="Authorization"
                          valuePlaceholder="Bearer …"
                          maskedHint
                        />
                        <FieldError message={at('headers')} />
                      </div>
                      {a.method !== 'GET' && a.method !== 'HEAD' && (
                        <div className="space-y-1">
                          <Label className="text-xs">Body (JSON or text)</Label>
                          <Textarea
                            className="min-h-[70px] font-mono text-xs"
                            value={a.body}
                            onChange={(e) => update(i, { body: e.target.value })}
                            placeholder={'{ "orderId": "{{input.id}}" }'}
                          />
                          <FieldError message={at('body')} />
                        </div>
                      )}
                    </>
                  )}

                  {(a.type === 'db.select' || a.type === 'db.insert' || a.type === 'db.update') && (
                    <>
                      <div className="space-y-1">
                        <Label className="text-xs">Table</Label>
                        <Input className="font-mono" value={a.table} onChange={(e) => update(i, { table: e.target.value })} placeholder="orders" />
                        <FieldError message={at('table')} />
                      </div>
                      {(a.type === 'db.select' || a.type === 'db.update') && (
                        <div className="space-y-1">
                          <Label className="text-xs">Filters {a.type === 'db.update' ? '(required)' : '(optional)'}</Label>
                          <PairsEditor
                            pairs={a.filters}
                            onChange={(filters) => update(i, { filters })}
                            keyPlaceholder="column"
                            valuePlaceholder="eq.{{input.id}}"
                          />
                          <FieldError message={at('filters')} />
                        </div>
                      )}
                      {a.type === 'db.select' && (
                        <div className="grid grid-cols-3 gap-2">
                          <div className="col-span-2 space-y-1">
                            <Label className="text-xs">Columns</Label>
                            <Input className="font-mono" value={a.select} onChange={(e) => update(i, { select: e.target.value })} placeholder="* (all)" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Row limit</Label>
                            <Input value={a.limit} onChange={(e) => update(i, { limit: e.target.value })} placeholder="100" />
                            <FieldError message={at('limit')} />
                          </div>
                        </div>
                      )}
                      {(a.type === 'db.insert' || a.type === 'db.update') && (
                        <div className="space-y-1">
                          <Label className="text-xs">{a.type === 'db.insert' ? 'Row to insert (JSON)' : 'Columns to change (JSON)'}</Label>
                          <Textarea
                            className="min-h-[70px] font-mono text-xs"
                            value={a.values}
                            onChange={(e) => update(i, { values: e.target.value })}
                            placeholder={'{ "email": "{{input.email}}" }'}
                          />
                          <FieldError message={at('values')} />
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">Runs with service-role access to the project database.</p>
                    </>
                  )}

                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => update(i, { advanced: !a.advanced })}
                  >
                    {a.advanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Step options
                  </button>
                  {a.advanced && (
                    <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/40 p-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Step name (for templates)</Label>
                        <Input className="h-8 font-mono text-xs" value={a.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="fetchUser" />
                        <FieldError message={at('name')} />
                      </div>
                      {a.type !== 'log' && (
                        <div className="space-y-1">
                          <Label className="text-xs">Timeout (seconds, 1–30)</Label>
                          <Input className="h-8 text-xs" value={a.timeoutSec} onChange={(e) => update(i, { timeoutSec: e.target.value })} placeholder="10" />
                          <FieldError message={at('timeout')} />
                        </div>
                      )}
                      <div className="space-y-1">
                        <Label className="text-xs">Retries on failure (0–5)</Label>
                        <Input className="h-8 text-xs" value={a.retries} onChange={(e) => update(i, { retries: e.target.value })} placeholder="0" />
                        <FieldError message={at('retries')} />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">First retry after (seconds)</Label>
                        <Input className="h-8 text-xs" value={a.retryDelaySec} onChange={(e) => update(i, { retryDelaySec: e.target.value })} placeholder="1" />
                        <FieldError message={at('retryDelay')} />
                      </div>
                      <label className="col-span-2 flex items-center gap-2 text-xs">
                        <Switch checked={a.continueOnError} onCheckedChange={(v) => update(i, { continueOnError: v })} />
                        Continue with the next step if this one fails
                      </label>
                      {a.type === 'http.request' && (
                        <label className="col-span-2 flex items-center gap-2 text-xs">
                          <Switch checked={a.followRedirects} onCheckedChange={(v) => update(i, { followRedirects: v })} />
                          Follow redirects
                        </label>
                      )}
                      <p className="col-span-2 text-xs text-muted-foreground">
                        A retry repeats only this step (never the steps before it), on network errors, timeouts and 5xx, 408 or 429 answers.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="space-y-2">
            <button
              type="button"
              className="flex items-center gap-1 text-sm font-medium"
              onClick={() => setShowLimits((v) => !v)}
            >
              {showLimits ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Limits
            </button>
            {showLimits && (
              <div className="grid grid-cols-2 gap-2 rounded-md border p-3">
                <div className="space-y-1">
                  <Label className="text-xs">Default step timeout (seconds, 1–30)</Label>
                  <Input className="h-8 text-xs" value={limits.timeoutSec} onChange={(e) => setLimits({ ...limits, timeoutSec: e.target.value })} placeholder="10" />
                  <FieldError message={errors['opt.timeout']} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Default retries per step (0–5)</Label>
                  <Input className="h-8 text-xs" value={limits.retries} onChange={(e) => setLimits({ ...limits, retries: e.target.value })} placeholder="0" />
                  <FieldError message={errors['opt.retries']} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Run time limit (seconds, 10–900)</Label>
                  <Input className="h-8 text-xs" value={limits.maxDurationSec} onChange={(e) => setLimits({ ...limits, maxDurationSec: e.target.value })} placeholder="300" />
                  <FieldError message={errors['opt.maxDuration']} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Runs of this flow at once (1–20)</Label>
                  <Input className="h-8 text-xs" value={limits.maxConcurrentRuns} onChange={(e) => setLimits({ ...limits, maxConcurrentRuns: e.target.value })} placeholder="No limit" />
                  <FieldError message={errors['opt.maxConcurrent']} />
                </div>
              </div>
            )}
          </div>

          {formError && <p className="rounded-md bg-red-500/10 p-2 text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} {editing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
