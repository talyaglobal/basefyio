'use client';

/**
 * Row-level security policies for a project database: one card per table with
 * its RLS state and policies, and a dialog that builds a policy from parts —
 * template, command, roles, USING / WITH CHECK expressions. The SQL in the
 * preview comes from the API's dry run, so what the user reads is exactly what
 * will run; "Check" runs it in a transaction that is rolled back.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { ColumnInfo } from '@/lib/types';
import {
  applyTemplate,
  commandTakesUsing,
  commandTakesWithCheck,
  EMAIL_COLUMN_CANDIDATES,
  OWNER_COLUMN_CANDIDATES,
  pickColumn,
  RLS_POLICY_COMMANDS,
  RLS_POLICY_TEMPLATES,
  type RlsHelpers,
  type RlsPoliciesOverview,
  type RlsPolicy,
  type RlsPolicyCommand,
  type RlsPolicyInput,
  type RlsPolicyRole,
  type RlsPolicyTable,
} from '@/lib/rls-policies';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const ROLE_HINTS: Record<RlsPolicyRole, string> = {
  anon: 'requests with the public key and no user session',
  authenticated: 'requests carrying a signed-in user token',
  service_role: 'the secret server key — it bypasses row-level security, so this grant is informational',
  public: 'every role',
};

interface DialogTarget {
  table: RlsPolicyTable;
  policy: RlsPolicy | null;
}

export function RlsPolicyEditor({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<RlsPoliciesOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyTable, setBusyTable] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await api.projects.dbPolicies(projectId));
    } catch (err: any) {
      toast.error(err.message);
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutateTable(table: string, action: () => Promise<{ message: string }>) {
    setBusyTable(table);
    try {
      const r = await action();
      toast.success(r.message);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusyTable(null);
    }
  }

  async function toggleRls(t: RlsPolicyTable, enabled: boolean) {
    if (!enabled) {
      const ok = await confirmDialog({
        title: `Disable row-level security on "${t.name}"`,
        description: `Every row in "${t.name}" becomes readable and writable to any key the table grants allow. The service key is unaffected either way.`,
        confirmText: 'Disable',
        destructive: true,
      });
      if (!ok) return;
    } else if (t.policies.length === 0) {
      const ok = await confirmDialog({
        title: `Enable row-level security on "${t.name}"`,
        description: `With RLS on and no policies, requests with the public key or a user token see no rows and cannot write. The service key still sees everything. Add a policy afterwards to open access back up.`,
        confirmText: 'Enable',
      });
      if (!ok) return;
    }
    await mutateTable(t.name, () => api.projects.dbSetRls(projectId, { table: t.name, enabled }));
  }

  async function toggleForce(t: RlsPolicyTable) {
    const force = !t.rlsForced;
    if (force) {
      const ok = await confirmDialog({
        title: `Force row-level security on "${t.name}"`,
        description: `Policies will also apply to the table owner. The dashboard's data grid still reads every row, but writes from the SQL editor and from direct connections are filtered too.`,
        confirmText: 'Force',
      });
      if (!ok) return;
    }
    await mutateTable(t.name, () =>
      api.projects.dbSetRls(projectId, { table: t.name, enabled: true, force }),
    );
  }

  async function dropPolicy(t: RlsPolicyTable, p: RlsPolicy) {
    const ok = await confirmDialog({
      title: 'Drop policy',
      description: `Drop policy "${p.name}" on "${t.name}"?`,
      confirmText: 'Drop',
      destructive: true,
    });
    if (!ok) return;
    await mutateTable(t.name, () => api.projects.dbDropPolicy(projectId, t.name, p.name));
  }

  if (loading && !overview) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Policies could not be loaded.{' '}
        <button type="button" className="underline" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Row-level security decides which rows each request may read or write. Switch it on per table,
          then add policies for the <code className="rounded bg-muted px-1 py-0.5 text-xs">anon</code> and{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">authenticated</code> roles; a request
          without a matching policy sees nothing. The service key always bypasses policies.
        </p>
        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={() => void load()} title="Reload">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {overview.helpers.uid === null && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          This database has no <code>auth.uid()</code> helper; templates read the signed-in user with{' '}
          <code>current_setting(&apos;request.jwt.claims&apos;, true)</code> directly.
        </div>
      )}

      {overview.tables.length === 0 ? (
        <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          No tables in the public schema yet.
        </div>
      ) : (
        overview.tables.map((t) => {
          const busy = busyTable === t.name;
          return (
            <div key={t.name} className="rounded-md border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium">{t.name}</span>
                  <Badge variant={t.rlsEnabled ? 'default' : 'outline'}>
                    {t.rlsForced ? 'RLS forced' : t.rlsEnabled ? 'RLS on' : 'RLS off'}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t.policies.length} {t.policies.length === 1 ? 'policy' : 'policies'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Row-level security
                    <Switch
                      checked={t.rlsEnabled}
                      disabled={busy}
                      onCheckedChange={(v) => void toggleRls(t, v)}
                      aria-label={`Row-level security on ${t.name}`}
                    />
                  </label>
                  {t.rlsEnabled && (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggleForce(t)}>
                      {t.rlsForced ? 'Stop forcing' : 'Force for owner'}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog({ table: t, policy: null })}>
                    <Plus className="mr-1.5 h-4 w-4" />
                    New policy
                  </Button>
                  {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </div>
              </div>

              {t.policies.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  {t.rlsEnabled
                    ? 'No policies — requests with the public key or a user token see no rows.'
                    : 'No policies. They take effect once row-level security is switched on.'}
                </p>
              ) : (
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">Command</th>
                        <th className="px-3 py-2 font-medium">Roles</th>
                        <th className="px-3 py-2 font-medium">Kind</th>
                        <th className="px-3 py-2 font-medium">USING</th>
                        <th className="px-3 py-2 font-medium">WITH CHECK</th>
                        <th className="w-20" />
                      </tr>
                    </thead>
                    <tbody>
                      {t.policies.map((p) => (
                        <tr key={p.name} className="border-b last:border-0 align-top">
                          <td className="px-3 py-2 font-mono text-xs">{p.name}</td>
                          <td className="px-3 py-2 font-mono text-xs">{p.command}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {p.roles.map((r) => (
                                <Badge key={r} variant="secondary" className="font-mono text-[10px]"
                                  title={r === 'service_role' ? 'Bypasses row-level security' : undefined}>
                                  {r}
                                </Badge>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs">{p.permissive ? 'Permissive' : 'Restrictive'}</td>
                          <td className="max-w-[320px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground" title={p.using ?? ''}>
                            {p.using ?? '—'}
                          </td>
                          <td className="max-w-[320px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground" title={p.withCheck ?? ''}>
                            {p.withCheck ?? '—'}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center justify-end gap-1">
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground"
                                disabled={busy} title="Edit policy" onClick={() => setDialog({ table: t, policy: p })}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                disabled={busy} title="Drop policy" onClick={() => void dropPolicy(t, p)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })
      )}

      {dialog && (
        <PolicyDialog
          projectId={projectId}
          table={dialog.table}
          policy={dialog.policy}
          helpers={overview.helpers}
          roles={overview.roles}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ────────────────────────────── dialog ────────────────────────────── */

interface PolicyForm {
  name: string;
  command: RlsPolicyCommand;
  roles: RlsPolicyRole[];
  permissive: boolean;
  using: string;
  withCheck: string;
}

function toInput(table: string, form: PolicyForm): RlsPolicyInput {
  const input: RlsPolicyInput = {
    table,
    name: form.name.trim(),
    command: form.command,
    roles: form.roles,
    permissive: form.permissive,
  };
  if (commandTakesUsing(form.command) && form.using.trim()) input.using = form.using;
  if (commandTakesWithCheck(form.command) && form.withCheck.trim()) input.withCheck = form.withCheck;
  return input;
}

function formFromPolicy(policy: RlsPolicy | null): PolicyForm {
  if (!policy) {
    return { name: '', command: 'SELECT', roles: ['authenticated'], permissive: true, using: '', withCheck: '' };
  }
  const known = new Set<string>(['anon', 'authenticated', 'service_role', 'public']);
  return {
    name: policy.name,
    command: policy.command,
    roles: policy.roles.filter((r): r is RlsPolicyRole => known.has(r)),
    permissive: policy.permissive,
    using: policy.using ?? '',
    withCheck: policy.withCheck ?? '',
  };
}

function PolicyDialog({
  projectId,
  table,
  policy,
  helpers,
  roles,
  onClose,
  onSaved,
}: {
  projectId: string;
  table: RlsPolicyTable;
  policy: RlsPolicy | null;
  helpers: RlsHelpers;
  roles: RlsPolicyRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<PolicyForm>(() => formFromPolicy(policy));
  const [templateId, setTemplateId] = useState('');
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [columnName, setColumnName] = useState('');
  const [preview, setPreview] = useState<{ sql?: string; error?: string }>({});
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const previewSeq = useRef(0);

  const template = RLS_POLICY_TEMPLATES.find((t) => t.id === templateId);
  const column = columns.find((c) => c.name === columnName);

  useEffect(() => {
    api.projects
      .columns(projectId, table.name, table.schema)
      .then(setColumns)
      .catch(() => setColumns([]));
  }, [projectId, table.name, table.schema]);

  // A template fills the form; the user can edit anything afterwards.
  function chooseTemplate(id: string) {
    setTemplateId(id);
    const next = RLS_POLICY_TEMPLATES.find((t) => t.id === id);
    if (!next) return;
    let col: ColumnInfo | undefined;
    if (next.column) {
      const candidates = next.column === 'owner' ? OWNER_COLUMN_CANDIDATES : EMAIL_COLUMN_CANDIDATES;
      col = columns.find((c) => c.name === columnName) ?? pickColumn(columns, candidates) ?? columns[0];
      setColumnName(col?.name ?? '');
    }
    const fill = applyTemplate(next, { helpers, column: col });
    setForm((f) => ({ ...f, ...fill, name: f.name || (policy ? f.name : next.id) }));
  }

  function chooseColumn(name: string) {
    setColumnName(name);
    if (!template?.column) return;
    const col = columns.find((c) => c.name === name);
    const fill = applyTemplate(template, { helpers, column: col });
    setForm((f) => ({ ...f, using: fill.using, withCheck: fill.withCheck }));
  }

  function toggleRole(role: RlsPolicyRole, on: boolean) {
    setForm((f) => ({
      ...f,
      roles: on ? [...f.roles.filter((r) => r !== role), role] : f.roles.filter((r) => r !== role),
    }));
  }

  // Live preview: the server builds and validates the SQL (dry run, no DB connection).
  useEffect(() => {
    if (!form.name.trim()) {
      setPreview({});
      return;
    }
    const seq = ++previewSeq.current;
    const input = toInput(table.name, form);
    const handle = setTimeout(async () => {
      try {
        const r = policy
          ? await api.projects.dbReplacePolicy(projectId, table.name, policy.name, { ...input, dryRun: true })
          : await api.projects.dbCreatePolicy(projectId, { ...input, dryRun: true });
        if (seq === previewSeq.current) setPreview({ sql: r.sql });
      } catch (err: any) {
        if (seq === previewSeq.current) setPreview({ error: err.message });
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [form, policy, projectId, table.name]);

  async function check() {
    setChecking(true);
    try {
      const input = toInput(table.name, form);
      const r = policy
        ? await api.projects.dbReplacePolicy(projectId, table.name, policy.name, { ...input, dryRun: true, check: true })
        : await api.projects.dbCreatePolicy(projectId, { ...input, dryRun: true, check: true });
      toast.success(r.message);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setChecking(false);
    }
  }

  async function apply() {
    setApplying(true);
    try {
      const input = toInput(table.name, form);
      const r = policy
        ? await api.projects.dbReplacePolicy(projectId, table.name, policy.name, input)
        : await api.projects.dbCreatePolicy(projectId, input);
      toast.success(r.message);
      onSaved();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setApplying(false);
    }
  }

  const usingEnabled = commandTakesUsing(form.command);
  const withCheckEnabled = commandTakesWithCheck(form.command);
  const canSubmit = form.name.trim().length > 0 && form.roles.length > 0 && !preview.error && !!preview.sql;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{policy ? `Edit policy "${policy.name}"` : 'New policy'} on {table.name}</DialogTitle>
          <DialogDescription>
            {policy
              ? 'Saving drops the existing policy and creates the new definition in one transaction.'
              : 'A policy lets the chosen roles act on the rows its expression accepts.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Start from a template (optional)</Label>
            <select value={templateId} onChange={(e) => chooseTemplate(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm">
              <option value="">Write the expressions by hand</option>
              {RLS_POLICY_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            {template && <p className="text-xs text-muted-foreground">{template.description}</p>}
          </div>

          {template?.column && (
            <div className="space-y-1.5">
              <Label>{template.column === 'owner' ? 'Owner column (holds the user id)' : 'Email column'}</Label>
              <select value={columnName} onChange={(e) => chooseColumn(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm">
                {columns.length === 0 && <option value="">No columns found</option>}
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="users_read_own_rows" spellCheck={false} />
            </div>
            <div className="space-y-1.5">
              <Label>Command</Label>
              <select value={form.command}
                onChange={(e) => setForm((f) => ({ ...f, command: e.target.value as RlsPolicyCommand }))}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm">
                {RLS_POLICY_COMMANDS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Applies to roles</Label>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {roles.map((role) => (
                <label key={role} className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={form.roles.includes(role)}
                    onChange={(e) => toggleRole(role, e.target.checked)} />
                  <span>
                    <span className="font-mono text-xs">{role}</span>
                    <span className="block text-xs text-muted-foreground">{ROLE_HINTS[role]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Kind</Label>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={form.permissive} onChange={() => setForm((f) => ({ ...f, permissive: true }))} />
                Permissive — rows pass if any permissive policy accepts them
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={!form.permissive} onChange={() => setForm((f) => ({ ...f, permissive: false }))} />
                Restrictive — rows must also pass this one
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>USING — which existing rows are visible or may be changed</Label>
            <Textarea value={form.using} disabled={!usingEnabled} spellCheck={false}
              onChange={(e) => setForm((f) => ({ ...f, using: e.target.value }))}
              placeholder={usingEnabled ? 'auth.uid() = "user_id"::text' : 'Not used by INSERT policies'}
              className="min-h-[64px] font-mono text-xs" />
          </div>

          <div className="space-y-1.5">
            <Label>WITH CHECK — which new or updated rows are accepted</Label>
            <Textarea value={form.withCheck} disabled={!withCheckEnabled} spellCheck={false}
              onChange={(e) => setForm((f) => ({ ...f, withCheck: e.target.value }))}
              placeholder={
                !withCheckEnabled
                  ? `Not used by ${form.command} policies`
                  : form.command === 'INSERT'
                    ? 'auth.uid() = "user_id"::text'
                    : 'Optional — defaults to the USING expression'
              }
              className="min-h-[64px] font-mono text-xs" />
          </div>

          <div className="space-y-1.5">
            <Label>SQL that will run</Label>
            {preview.error ? (
              <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">{preview.error}</pre>
            ) : preview.sql ? (
              <pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">{preview.sql}</pre>
            ) : (
              <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                Enter a name to preview the statement.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={applying}>Cancel</Button>
          <Button variant="secondary" onClick={() => void check()} disabled={!canSubmit || checking || applying}
            title="Run the statement in a transaction that is rolled back, so Postgres validates it">
            {checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Check against database
          </Button>
          <Button onClick={() => void apply()} disabled={!canSubmit || applying}>
            {applying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {policy ? 'Save changes' : 'Create policy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
