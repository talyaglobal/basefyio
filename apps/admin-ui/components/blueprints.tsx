'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import type {
  BlueprintSummary,
  BlueprintDetail,
  BlueprintSheet,
  DataModel,
  DataModelTable,
  InferredColumn,
  ProjectListItem,
  MigrationRun,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  FileSpreadsheet,
  Upload,
  Loader2,
  Trash2,
  CheckCircle2,
  ArrowLeft,
  Table2,
  Database,
  Download,
  Pencil,
} from 'lucide-react';
import { formatDate } from '@/lib/format';

const MAX_SAMPLE_ROWS = 200;
const COLUMN_TYPES = ['text', 'integer', 'bigint', 'numeric', 'boolean', 'date', 'timestamptz', 'uuid', 'jsonb'];

/** A small starter workbook: one sheet per table, header row + example rows. */
function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['name', 'email', 'phone', 'created_at'],
      ['Ada Lovelace', 'ada@example.com', '+44 20 7946 0000', '2026-01-15'],
      ['Alan Turing', 'alan@example.com', '+44 20 7946 0001', '2026-02-03'],
    ]),
    'customers',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['order_number', 'customer_email', 'total', 'status', 'ordered_at'],
      ['A-1001', 'ada@example.com', 120.5, 'paid', '2026-02-10'],
      ['A-1002', 'alan@example.com', 80, 'pending', '2026-02-11'],
    ]),
    'orders',
  );
  XLSX.writeFile(wb, 'basefyio-starter-template.xlsx');
}

/**
 * CSV bytes are decoded here: SheetJS reads a byte array as Latin-1, which turns
 * UTF-8 Turkish text into mojibake. A BOM decides; otherwise strictly valid UTF-8
 * wins and anything else is Windows-1254 (what Turkish Excel saves).
 */
function decodeCsv(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1254').decode(buf);
  }
}

/** An Excel date cell as text in the user's own calendar (no UTC shift): date only at midnight. */
function dateCell(v: unknown): unknown {
  if (!(v instanceof Date)) return v;
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  return v.getHours() || v.getMinutes() || v.getSeconds() ? `${day} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}` : day;
}

async function parseSheets(file: File): Promise<BlueprintSheet[]> {
  const buf = await file.arrayBuffer();
  const isCsv = /\.csv$/i.test(file.name);
  // raw: keep CSV cells as text ("12,50", "01.02.2026"); the server reads them in the file's locale.
  const wb = isCsv
    ? XLSX.read(decodeCsv(buf), { type: 'string', raw: true })
    : XLSX.read(buf, { type: 'array', cellDates: true });
  const sheets: BlueprintSheet[] = [];
  for (const sheetName of wb.SheetNames) {
    // A CSV has one anonymous sheet: the table takes the file's name.
    const name = isCsv ? file.name.replace(/\.csv$/i, '') : sheetName;
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
    if (rows.length < 2) continue;
    const headers = (rows[0] as unknown[]).map((h) => String(h ?? ''));
    const dataRows = (rows.slice(1, 1 + MAX_SAMPLE_ROWS) as unknown[][]).map((r) => r.map(dateCell));
    sheets.push({ name, headers, rows: dataRows });
  }
  return sheets;
}

function safetyColor(safety: string) {
  switch (safety) {
    case 'destructive':
      return 'text-red-600 dark:text-red-400';
    case 'review':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-green-600 dark:text-green-400';
  }
}

function statusVariant(status: string) {
  switch (status) {
    case 'GENERATED':
      return 'bg-green-500/15 text-green-600 dark:text-green-400';
    case 'APPROVED':
      return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
    case 'GENERATING':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'FAILED':
      return 'bg-red-500/15 text-red-600 dark:text-red-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

export function Blueprints({ teamId }: { teamId: string | null }) {
  const [list, setList] = useState<BlueprintSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const [pending, setPending] = useState<{ file: File; name: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!teamId) return;
    try {
      setList(await api.blueprints.list(teamId));
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load blueprints');
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) setPending({ file, name: file.name.replace(/.(xlsx|xls|csv)$/i, '') });
  };

  const analyze = async () => {
    if (!pending || !teamId) return;
    setAnalyzing(true);
    try {
      const sheets = await parseSheets(pending.file);
      if (sheets.length === 0) {
        toast.error('No usable sheets found (need a header row + data)');
        return;
      }
      const bp = await api.blueprints.analyze({ teamId, name: pending.name.trim() || 'Untitled', sheets });
      toast.success(`Analyzed ${sheets.length} sheet(s)`);
      setPending(null);
      router.push(`/dashboard/blueprints/${bp.id}`);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to analyze file');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <FileSpreadsheet className="h-5 w-5 text-[#217346]" /> Sheet to App
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload an Excel/CSV file and turn it into real database tables for a project.
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          className="hidden"
          onChange={onFile}
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={downloadTemplate}>
            <Download className="mr-1 h-4 w-4" /> Starter template
          </Button>
          <Button onClick={() => fileRef.current?.click()} disabled={analyzing || !teamId}>
            <Upload className="mr-1 h-4 w-4" />
            New from Excel
          </Button>
        </div>
      </div>

      {pending && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
          <FileSpreadsheet className="h-4 w-4 text-[#217346]" />
          <span className="max-w-[14rem] truncate text-sm text-muted-foreground">{pending.file.name}</span>
          <Input
            aria-label="Blueprint name"
            className="w-64"
            value={pending.name}
            onChange={(e) => setPending({ ...pending, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && analyze()}
          />
          <Button onClick={analyze} disabled={analyzing}>
            {analyzing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Analyze
          </Button>
          <Button variant="ghost" onClick={() => setPending(null)} disabled={analyzing}>
            Cancel
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No blueprints yet. Upload an Excel file to get started.
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((bp) => (
            <button
              key={bp.id}
              onClick={() => router.push(`/dashboard/blueprints/${bp.id}`)}
              className="flex w-full items-center gap-3 rounded-lg border bg-card p-4 text-left hover:bg-accent"
            >
              <Database className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{bp.name}</div>
                <div className="text-xs text-muted-foreground">
                  {bp.domain ?? 'generic'} · {formatDate(bp.createdAt)}
                </div>
              </div>
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusVariant(bp.status)}`}>
                {bp.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BlueprintDetailView({
  id,
  teamId,
  onBack,
}: {
  id: string;
  teamId: string | null;
  onBack: () => void;
}) {
  const [bp, setBp] = useState<BlueprintDetail | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [targetProject, setTargetProject] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<MigrationRun | null>(null);
  const resyncRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<DataModel | null>(null);
  const [importData, setImportData] = useState(false);
  const [dataSheets, setDataSheets] = useState<BlueprintSheet[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const dataRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const detail = await api.blueprints.get(id);
      setBp(detail);
      setTargetProject((prev) => prev || detail.projectId || '');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to load blueprint');
    }
  }, [id]);

  useEffect(() => {
    load();
    if (teamId) api.projects.list(teamId).then(setProjects).catch(() => {});
  }, [load, teamId]);

  const onResync = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const sheets = await parseSheets(file);
      if (sheets.length === 0) {
        toast.error('No usable sheets found');
        return;
      }
      await api.blueprints.resync(id, sheets);
      setPlan(null);
      toast.success('Data model updated — you can now plan a migration');
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to sync');
    } finally {
      setBusy(false);
    }
  };

  const onDataFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const sheets = await parseSheets(file);
      if (sheets.length === 0) toast.error('No usable sheets found');
      else setDataSheets(sheets);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to read the file');
    }
  };

  const planMigration = async () => {
    setBusy(true);
    try {
      const run = await api.migrations.plan(id);
      setPlan(run);
      if (run.plan.changes.length === 0) toast.info('No schema changes detected');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to plan migration');
    } finally {
      setBusy(false);
    }
  };

  const applyMigration = async () => {
    if (!plan) return;
    const destructive = plan.plan.hasDestructive;
    if (destructive) {
      const ok = await confirmDialog({
        title: 'Apply destructive migration',
        description: 'This plan contains destructive changes (dropped tables/columns or type changes) that may lose data. Apply anyway?',
        confirmText: 'Apply (force)',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await api.migrations.apply(plan.id, destructive);
      toast.success(`Migration applied (${res.appliedCount} change(s))`);
      setPlan(null);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to apply migration');
    } finally {
      setBusy(false);
    }
  };

  const editTable = (ti: number, patch: Partial<DataModelTable>) =>
    setDraft((d) => d && { ...d, tables: d.tables.map((t, i) => (i === ti ? { ...t, ...patch } : t)) });

  const editColumn = (ti: number, ci: number, patch: Partial<InferredColumn>) =>
    setDraft(
      (d) =>
        d && {
          ...d,
          tables: d.tables.map((t, i) =>
            i === ti ? { ...t, columns: t.columns.map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : t,
          ),
        },
    );

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await api.blueprints.update(id, { dataModel: draft });
      setDraft(null);
      setPlan(null);
      toast.success('Data model saved');
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!bp?.applicationModel) return;
    setBusy(true);
    try {
      await api.blueprints.approve(bp.id, bp.applicationModel);
      toast.success('Approved');
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to approve');
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!targetProject) {
      toast.error('Select a target project first');
      return;
    }
    const ok = await confirmDialog({
      title: 'Generate tables',
      description: `Create ${bp?.dataModel.tables.length ?? 0} table(s) in the selected project's database${importData ? ' and import the rows of the chosen file' : ''}? Existing tables with the same name are left as they are; use "Plan changes" to change those.`,
      confirmText: 'Generate',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.blueprints.generate(bp!.id, targetProject, importData ? (dataSheets ?? undefined) : undefined);
      const rowCount = Object.values(res.rows ?? {}).reduce((n, c) => n + c, 0);
      toast.success(
        `Generated: ${res.created} created, ${res.skipped} skipped${rowCount ? `, ${rowCount} row(s) imported` : ''}`,
      );
      if (res.pendingChanges) {
        toast.info('The model differs from the existing tables. Use "Plan changes" under Schema migrations to apply it.');
      }
      setNotes(res.notes ?? []);
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to generate');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: 'Delete blueprint',
      description: 'Delete this blueprint? Generated tables are not removed.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.blueprints.remove(id);
      toast.success('Blueprint deleted');
      onBack();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to delete');
    }
  };

  if (!bp) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <button onClick={onBack} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{bp.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusVariant(bp.status)}`}>
              {bp.status}
            </span>
            <span>{bp.domain ?? 'generic'}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={resyncRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={onResync}
          />
          <Button variant="outline" size="sm" onClick={() => resyncRef.current?.click()} disabled={busy}>
            <Upload className="mr-1 h-3.5 w-3.5" /> Sync from Excel
          </Button>
          <Button variant="ghost" size="sm" onClick={remove}>
            <Trash2 className="h-4 w-4 text-red-500" />
          </Button>
        </div>
      </div>

      {/* Tables */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">
            Data model ({bp.dataModel.tables.length} table{bp.dataModel.tables.length === 1 ? '' : 's'})
          </h2>
          {draft ? (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={saveDraft} disabled={busy}>
                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                Save changes
              </Button>
            </div>
          ) : (
            bp.status !== 'GENERATING' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDraft(structuredClone(bp.dataModel))}
                disabled={busy}
              >
                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
              </Button>
            )
          )}
        </div>
        {!draft && bp.dataModel.warnings && bp.dataModel.warnings.length > 0 && (
          <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
            {bp.dataModel.warnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </div>
        )}
        {!draft && bp.dataModel.relations && bp.dataModel.relations.length > 0 && (
          <div className="rounded-lg border bg-card p-3 text-xs text-muted-foreground">
            Links found: {bp.dataModel.relations.map((r) => `${r.fromTable}.${r.fromColumn} → ${r.toTable}.${r.toColumn}`).join(', ')}
          </div>
        )}
        {draft
          ? draft.tables.map((t, ti) => (
              <div key={ti} className="space-y-2 rounded-lg border bg-card p-4">
                <div className="flex items-center gap-2">
                  <Table2 className="h-4 w-4 text-primary" />
                  <Input
                    aria-label="Table name"
                    value={t.name}
                    className="h-8 max-w-xs font-medium"
                    onChange={(e) => editTable(ti, { name: e.target.value })}
                  />
                </div>
                {t.columns.map((c, ci) => (
                  <div key={ci} className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label="Column name"
                      value={c.name}
                      className="h-8 w-48"
                      onChange={(e) => editColumn(ti, ci, { name: e.target.value })}
                    />
                    <select
                      aria-label="Column type"
                      value={c.type}
                      className="h-8 rounded-md border bg-background px-2 text-sm"
                      onChange={(e) => editColumn(ti, ci, { type: e.target.value as InferredColumn['type'] })}
                    >
                      {COLUMN_TYPES.map((ty) => (
                        <option key={ty} value={ty}>
                          {ty}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={c.nullable}
                        onChange={(e) => editColumn(ti, ci, { nullable: e.target.checked })}
                      />
                      nullable
                    </label>
                    {c.sampleValues[0] && (
                      <span className="text-xs text-muted-foreground">
                        e.g. {c.sampleValues.slice(0, 2).join(', ')}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))
          : bp.dataModel.tables.map((t) => (
              <div key={t.name} className="rounded-lg border bg-card p-4">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <Table2 className="h-4 w-4 text-primary" /> {t.name}
                  {t.label !== t.name && (
                    <span className="text-xs text-muted-foreground">({t.label})</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {t.columns.map((c) => (
                    <Badge key={c.name} variant="secondary" className="text-xs font-normal">
                      {c.name}: {c.type}
                      {c.nullable ? '' : ' (required)'}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
        {bp.status === 'DRAFT' && (
          <Button onClick={approve} disabled={busy || !!draft}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            <CheckCircle2 className="mr-1 h-4 w-4" /> Approve
          </Button>
        )}
        {(bp.status === 'APPROVED' || bp.status === 'GENERATED' || bp.status === 'FAILED') && (
          <>
            <Combobox
              className="w-64"
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              value={targetProject}
              onValueChange={setTargetProject}
              placeholder="Select target project"
              searchPlaceholder="Search projects…"
            />
            <Button onClick={generate} disabled={busy || !targetProject || (importData && !dataSheets)}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              <Database className="mr-1 h-4 w-4" />
              {bp.generatedDataModel ? 'Re-generate' : 'Generate tables'}
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={importData} onChange={(e) => setImportData(e.target.checked)} />
              Import the rows too
            </label>
            {importData && (
              <>
                <input ref={dataRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onDataFile} />
                <Button variant="outline" size="sm" onClick={() => dataRef.current?.click()} disabled={busy}>
                  <Upload className="mr-1 h-3.5 w-3.5" /> {dataSheets ? `${dataSheets.length} sheet(s) ready` : 'Choose the file'}
                </Button>
              </>
            )}
          </>
        )}
      </div>

      {notes.length > 0 && (
        <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          {notes.map((n, i) => (
            <div key={i}>{n}</div>
          ))}
        </div>
      )}

      {/* Migrations — available once tables exist, also after "Sync from Excel" set the status back to APPROVED */}
      {(bp.status === 'GENERATED' || (bp.status === 'APPROVED' && bp.generatedDataModel)) && (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Schema migrations</h2>
            <Button size="sm" variant="outline" onClick={planMigration} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Plan changes
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Use “Sync from Excel” to update the model, then plan a migration to apply the diff to the
            generated tables.
          </p>

          {plan && (
            <div className="space-y-2">
              {plan.plan.changes.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No changes — generated tables match the current model.
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    {plan.plan.changes.map((c, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm">
                        <span className={`font-mono text-xs ${safetyColor(c.safety)}`}>
                          {c.safety}
                        </span>
                        <span>{c.detail}</span>
                      </div>
                    ))}
                  </div>
                  <Button onClick={applyMigration} disabled={busy} size="sm">
                    {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    Apply migration
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
