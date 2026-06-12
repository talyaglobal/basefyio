'use client';

/**
 * Database management — Supabase-style Indexes / Triggers / Functions /
 * Extensions for the project database. Postgres functions created here are
 * instantly callable as APIs via POST /rest/v1/rpc/{name}.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Plus, Trash2, RefreshCw } from 'lucide-react';

type Tab = 'indexes' | 'triggers' | 'functions' | 'extensions';

const FN_TEMPLATE = `CREATE OR REPLACE FUNCTION hello(name text)
RETURNS text
LANGUAGE sql
AS $$
  SELECT 'Hello, ' || name;
$$;`;

export default function DatabasePage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('indexes');
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<any[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Create-index form
  const [ixTable, setIxTable] = useState('');
  const [ixColumns, setIxColumns] = useState('');
  const [ixUnique, setIxUnique] = useState(false);
  const [ixMethod, setIxMethod] = useState('btree');
  // Create-trigger form
  const [trName, setTrName] = useState('');
  const [trTable, setTrTable] = useState('');
  const [trTiming, setTrTiming] = useState<'BEFORE' | 'AFTER'>('AFTER');
  const [trEvents, setTrEvents] = useState<string[]>(['INSERT']);
  const [trFn, setTrFn] = useState('');
  // Create-function form
  const [fnSql, setFnSql] = useState(FN_TEMPLATE);

  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    try {
      const data =
        t === 'indexes' ? await api.projects.dbIndexes(id)
        : t === 'triggers' ? await api.projects.dbTriggers(id)
        : t === 'functions' ? await api.projects.dbFunctions(id)
        : await api.projects.dbExtensions(id);
      setRows(data as any[]);
    } catch (err: any) {
      toast.error(err.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(tab); }, [tab, load]);
  useEffect(() => {
    api.projects.tables(id).then((t) => setTables(t.map((x: any) => x.name))).catch(() => {});
  }, [id]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      setDialogOpen(false);
      await load(tab);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  const tabBtn = (t: Tab, label: string) => (
    <button
      key={t}
      type="button"
      onClick={() => setTab(t)}
      className={`rounded px-3 py-1.5 text-sm ${tab === t ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Database</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => load(tab)}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {tab !== 'extensions' && (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New {tab.slice(0, -2)}{tab === 'indexes' ? 'x' : ''}
            </Button>
          )}
        </div>
      </div>

      <div className="inline-flex rounded-lg border bg-muted/40 p-1">
        {tabBtn('indexes', 'Indexes')}
        {tabBtn('triggers', 'Triggers')}
        {tabBtn('functions', 'Functions')}
        {tabBtn('extensions', 'Extensions')}
      </div>

      {tab === 'functions' && (
        <p className="text-sm text-muted-foreground">
          Functions are callable as APIs:{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">POST /rest/v1/rpc/&#123;name&#125;</code>{' '}
          with JSON args, or <code className="rounded bg-muted px-1.5 py-0.5 text-xs">bf.rpc(&apos;name&apos;, args)</code> from the SDK.
        </p>
      )}

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          No {tab} yet.
        </div>
      ) : (
        <div className="overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left">
                {tab === 'indexes' && <><th className="px-3 py-2">Name</th><th className="px-3 py-2">Table</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Definition</th><th className="w-12" /></>}
                {tab === 'triggers' && <><th className="px-3 py-2">Name</th><th className="px-3 py-2">Table</th><th className="px-3 py-2">Enabled</th><th className="px-3 py-2">Definition</th><th className="w-12" /></>}
                {tab === 'functions' && <><th className="px-3 py-2">Name</th><th className="px-3 py-2">Args</th><th className="px-3 py-2">Returns</th><th className="px-3 py-2">Lang</th><th className="w-12" /></>}
                {tab === 'extensions' && <><th className="px-3 py-2">Name</th><th className="px-3 py-2">Version</th><th className="px-3 py-2">Description</th><th className="px-3 py-2">Enabled</th></>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0 align-top">
                  {tab === 'indexes' && (
                    <>
                      <td className="px-3 py-2 font-mono text-xs">{r.name}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.table}</td>
                      <td className="px-3 py-2 text-xs">{r.size}</td>
                      <td className="max-w-[480px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground" title={r.definition}>{r.definition}</td>
                      <td className="px-2 py-2">
                        {!r.isPrimary && (
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={async () => {
                              if (!(await confirmDialog({ title: 'Drop index', description: `Drop index "${r.name}"?`, destructive: true }))) return;
                              void run(() => api.projects.dbDropIndex(id, r.name), 'Index dropped');
                            }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </>
                  )}
                  {tab === 'triggers' && (
                    <>
                      <td className="px-3 py-2 font-mono text-xs">{r.name}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.table}</td>
                      <td className="px-3 py-2">
                        <button type="button" role="switch" aria-checked={r.enabled}
                          onClick={() => void run(() => api.projects.dbToggleTrigger(id, { name: r.name, table: r.table, enabled: !r.enabled }), `Trigger ${r.enabled ? 'disabled' : 'enabled'}`)}
                          className={`relative h-5 w-9 rounded-full transition-colors ${r.enabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${r.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                      </td>
                      <td className="max-w-[420px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground" title={r.definition}>{r.definition}</td>
                      <td className="px-2 py-2">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={async () => {
                            if (!(await confirmDialog({ title: 'Drop trigger', description: `Drop trigger "${r.name}" on "${r.table}"?`, destructive: true }))) return;
                            void run(() => api.projects.dbDropTrigger(id, r.table, r.name), 'Trigger dropped');
                          }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </>
                  )}
                  {tab === 'functions' && (
                    <>
                      <td className="px-3 py-2 font-mono text-xs">{r.name}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{r.args || '—'}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{r.returns}</td>
                      <td className="px-3 py-2 text-xs">{r.language}</td>
                      <td className="px-2 py-2">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={async () => {
                            if (!(await confirmDialog({ title: 'Drop function', description: `Drop function "${r.name}(${r.args})"?`, destructive: true }))) return;
                            void run(() => api.projects.dbDropFunction(id, r.name, r.args), 'Function dropped');
                          }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </>
                  )}
                  {tab === 'extensions' && (
                    <>
                      <td className="px-3 py-2 font-mono text-xs">{r.name}</td>
                      <td className="px-3 py-2 text-xs">{r.installedVersion || r.defaultVersion}</td>
                      <td className="max-w-[420px] px-3 py-2 text-xs text-muted-foreground">{r.comment}</td>
                      <td className="px-3 py-2">
                        <button type="button" role="switch" aria-checked={r.enabled} disabled={busy}
                          onClick={async () => {
                            if (r.enabled && !(await confirmDialog({ title: 'Disable extension', description: `Disable "${r.name}"? Objects depending on it may break.`, destructive: true }))) return;
                            void run(() => api.projects.dbSetExtension(id, { name: r.name, enabled: !r.enabled }), `Extension ${r.enabled ? 'disabled' : 'enabled'}`);
                          }}
                          className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-50 ${r.enabled ? 'bg-primary' : 'bg-muted-foreground/30'}`}>
                          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${r.enabled ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialogs */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {tab === 'indexes' ? 'Create index' : tab === 'triggers' ? 'Create trigger' : 'Create function'}
            </DialogTitle>
          </DialogHeader>

          {tab === 'indexes' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Table</Label>
                <select value={ixTable} onChange={(e) => setIxTable(e.target.value)} className="h-9 w-full rounded-md border bg-background px-3 text-sm">
                  <option value="">Select table…</option>
                  {tables.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Columns (comma-separated)</Label>
                <Input value={ixColumns} onChange={(e) => setIxColumns(e.target.value)} placeholder="email, created_at" />
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={ixUnique} onChange={(e) => setIxUnique(e.target.checked)} /> Unique
                </label>
                <select value={ixMethod} onChange={(e) => setIxMethod(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
                  {['btree', 'hash', 'gin', 'gist', 'brin'].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
          )}

          {tab === 'triggers' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input value={trName} onChange={(e) => setTrName(e.target.value)} placeholder="on_user_change" />
                </div>
                <div className="space-y-1.5">
                  <Label>Table</Label>
                  <select value={trTable} onChange={(e) => setTrTable(e.target.value)} className="h-9 w-full rounded-md border bg-background px-3 text-sm">
                    <option value="">Select…</option>
                    {tables.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <select value={trTiming} onChange={(e) => setTrTiming(e.target.value as 'BEFORE' | 'AFTER')} className="h-9 rounded-md border bg-background px-3 text-sm">
                  <option value="BEFORE">BEFORE</option>
                  <option value="AFTER">AFTER</option>
                </select>
                {['INSERT', 'UPDATE', 'DELETE'].map((ev) => (
                  <label key={ev} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={trEvents.includes(ev)}
                      onChange={(e) => setTrEvents((p) => e.target.checked ? [...p, ev] : p.filter((x) => x !== ev))} />
                    {ev}
                  </label>
                ))}
              </div>
              <div className="space-y-1.5">
                <Label>Function to execute (must exist, return trigger)</Label>
                <Input value={trFn} onChange={(e) => setTrFn(e.target.value)} placeholder="my_trigger_fn" />
              </div>
            </div>
          )}

          {tab === 'functions' && (
            <div className="space-y-1.5">
              <Label>CREATE FUNCTION statement</Label>
              <textarea value={fnSql} onChange={(e) => setFnSql(e.target.value)} spellCheck={false}
                className="h-56 w-full resize-y rounded-md border bg-muted/30 p-3 font-mono text-xs" />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>Cancel</Button>
            <Button disabled={busy} onClick={() => {
              if (tab === 'indexes') {
                const columns = ixColumns.split(',').map((c) => c.trim()).filter(Boolean);
                if (!ixTable || !columns.length) { toast.error('Table and columns required'); return; }
                void run(() => api.projects.dbCreateIndex(id, { table: ixTable, columns, unique: ixUnique, method: ixMethod }), 'Index created');
              } else if (tab === 'triggers') {
                if (!trName || !trTable || !trFn || !trEvents.length) { toast.error('All fields required'); return; }
                void run(() => api.projects.dbCreateTrigger(id, { name: trName, table: trTable, timing: trTiming, events: trEvents as any, functionName: trFn }), 'Trigger created');
              } else {
                void run(() => api.projects.dbCreateFunction(id, fnSql), 'Function created');
              }
            }}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
