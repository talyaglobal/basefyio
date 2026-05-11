'use client';

/**
 * Multi-step Import Data wizard.
 *
 * Lifecycle:
 *   1. upload   — user drops/selects a CSV/XLSX, we hit POST /inspect
 *   2. configure — user reviews inferred schema, picks target (existing
 *                  table OR create new), conflict strategy, column mapping
 *   3. running  — SSE-driven progress bar; the dialog can be closed while
 *                  the worker continues (job lives in BullMQ)
 *   4. done     — summary with rowsRead / rowsInserted / rowsSkipped / rowsBad
 *                  plus a link to download the bad-rows CSV when present
 *
 * Critical UX choices baked in:
 *   * Source columns the user doesn't want imported can be "skipped" — they
 *     just aren't included in the mapping array sent to /jobs.
 *   * Type overrides are user-editable on the preview step; the validator on
 *     the server respects whatever we send.
 *   * Conflict columns are required for skip/update modes; we surface the
 *     existing table's columns (fetched lazily) so the user picks from a real
 *     list rather than guessing.
 */

import { useEffect, useMemo, useState } from 'react';
import { Upload, FileSpreadsheet, X, ArrowRight, Loader2, CheckCircle2, AlertTriangle, Download } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import type {
  DataImportColumnType,
  DataImportInspectResult,
  DataImportInferredColumn,
  DataImportProgress,
  DataImportResult,
  TableInfo,
} from '@/lib/types';

const TYPE_OPTIONS: DataImportColumnType[] = [
  'text',
  'integer',
  'bigint',
  'numeric',
  'boolean',
  'date',
  'timestamptz',
  'uuid',
  'jsonb',
];

type WizardStep = 'upload' | 'configure' | 'running' | 'done';

export interface ImportDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** Tables list from the Table Editor — used to populate the existing-table picker. */
  tables: TableInfo[];
  /** Suggested target table when the user clicked Import while a table was selected. */
  defaultTargetTable?: string | null;
  /** Called when the import completes successfully so the parent can refresh. */
  onCompleted?: () => void;
}

interface MappingRow {
  source: string;
  target: string;
  type: DataImportColumnType;
  nullable: boolean;
  /** When false, the user has chosen to drop this column from the import. */
  include: boolean;
}

export function ImportDataDialog(props: ImportDataDialogProps) {
  const { open, onOpenChange, projectId, tables, defaultTargetTable, onCompleted } = props;

  const [step, setStep] = useState<WizardStep>('upload');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<DataImportInspectResult | null>(null);
  const [targetMode, setTargetMode] = useState<'existing' | 'new'>('existing');
  const [targetTable, setTargetTable] = useState<string>('');
  const [newTableName, setNewTableName] = useState<string>('');
  const [conflictMode, setConflictMode] = useState<'skip' | 'update' | 'fail'>('skip');
  const [conflictColumns, setConflictColumns] = useState<string[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [existingColumns, setExistingColumns] = useState<{ name: string; type: string }[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DataImportProgress | null>(null);
  const [result, setResult] = useState<DataImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state when dialog reopens.
  useEffect(() => {
    if (!open) return;
    setStep('upload');
    setBusy(false);
    setFile(null);
    setInspect(null);
    setTargetMode(defaultTargetTable ? 'existing' : 'new');
    setTargetTable(defaultTargetTable || '');
    setNewTableName('');
    setConflictMode('skip');
    setConflictColumns([]);
    setMappings([]);
    setExistingColumns([]);
    setJobId(null);
    setProgress(null);
    setResult(null);
    setError(null);
  }, [open, defaultTargetTable]);

  // When the user picks an existing table, fetch its columns so the mapping
  // selector knows what targets are available.
  useEffect(() => {
    if (targetMode !== 'existing' || !targetTable) {
      setExistingColumns([]);
      return;
    }
    let cancelled = false;
    api.projects
      .columns(projectId, targetTable)
      .then((cols) => {
        if (cancelled) return;
        setExistingColumns(cols.map((c) => ({ name: c.name, type: c.type })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [targetMode, targetTable, projectId]);

  // Auto-map inferred → target columns on existing-table mode.
  useEffect(() => {
    if (!inspect) return;
    if (targetMode === 'existing' && existingColumns.length > 0) {
      const targetByName = new Map(existingColumns.map((c) => [c.name.toLowerCase(), c.name]));
      setMappings(
        inspect.inferredColumns.map((c) =>
          buildMappingRow(c, targetByName.get(c.name.toLowerCase()) ?? ''),
        ),
      );
    } else if (targetMode === 'new') {
      setMappings(
        inspect.inferredColumns.map((c) => buildMappingRow(c, c.name)),
      );
    }
  }, [inspect, targetMode, existingColumns]);

  async function handleFileUpload(f: File) {
    setBusy(true);
    setError(null);
    try {
      const insp = await api.projects.inspectDataImport(projectId, f);
      setFile(f);
      setInspect(insp);
      setStep('configure');
    } catch (e: any) {
      setError(e?.message || 'Inspect failed');
      toast.error(e?.message || 'Inspect failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    if (!inspect) return;
    const active = mappings.filter((m) => m.include && m.target);
    if (active.length === 0) {
      toast.error('Map at least one column before starting the import.');
      return;
    }
    if (targetMode === 'new' && !newTableName) {
      toast.error('Choose a name for the new table.');
      return;
    }
    if ((conflictMode === 'skip' || conflictMode === 'update') && conflictColumns.length === 0) {
      toast.error('Pick at least one conflict column for skip/update modes.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const tableName = targetMode === 'new' ? newTableName : targetTable;
      const { jobId: id } = await api.projects.startDataImport(projectId, {
        sourceKey: inspect.sourceKey,
        filename: inspect.filename,
        format: inspect.format,
        targetMode,
        tableName,
        conflictMode,
        conflictColumns: conflictColumns.length ? conflictColumns : undefined,
        columns: active.map((m) => ({
          source: m.source,
          target: m.target,
          type: m.type,
          nullable: m.nullable,
        })),
      });
      setJobId(id);
      setStep('running');
    } catch (e: any) {
      setError(e?.message || 'Start failed');
      toast.error(e?.message || 'Start failed');
    } finally {
      setBusy(false);
    }
  }

  // Subscribe to SSE once we have a jobId.
  useEffect(() => {
    if (step !== 'running' || !jobId) return;
    const es = api.projects.streamDataImportEvents(projectId, jobId, {
      onProgress: (p) => setProgress(p),
      onState: () => undefined,
      onCompleted: (r) => {
        setResult(r);
        setStep('done');
        onCompleted?.();
      },
      onFailed: (msg) => {
        setError(msg);
        setStep('done');
      },
      onError: () => undefined,
    });
    return () => {
      es.close();
    };
  }, [step, jobId, projectId, onCompleted]);

  const percent = progress?.percent ?? 0;
  const rowsRead = progress?.rowsRead ?? result?.rowsRead ?? 0;
  const rowsInserted = progress?.rowsInserted ?? result?.rowsInserted ?? 0;
  const rowsBad = progress?.rowsBad ?? result?.rowsBad ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import data</DialogTitle>
          <DialogDescription>
            Upload a CSV or XLSX file, map its columns to a table, and run the import in the background.
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <UploadStep busy={busy} onFile={handleFileUpload} error={error} />
        )}

        {step === 'configure' && inspect && (
          <ConfigureStep
            inspect={inspect}
            tables={tables}
            targetMode={targetMode}
            setTargetMode={setTargetMode}
            targetTable={targetTable}
            setTargetTable={setTargetTable}
            newTableName={newTableName}
            setNewTableName={setNewTableName}
            conflictMode={conflictMode}
            setConflictMode={setConflictMode}
            conflictColumns={conflictColumns}
            setConflictColumns={setConflictColumns}
            mappings={mappings}
            setMappings={setMappings}
            existingColumns={existingColumns}
          />
        )}

        {step === 'running' && (
          <RunningStep
            percent={percent}
            detail={progress?.detail || 'Starting…'}
            rowsRead={rowsRead}
            rowsInserted={rowsInserted}
            rowsBad={rowsBad}
          />
        )}

        {step === 'done' && (
          <DoneStep
            projectId={projectId}
            jobId={jobId}
            result={result}
            rowsRead={rowsRead}
            rowsInserted={rowsInserted}
            rowsBad={rowsBad}
            error={error}
          />
        )}

        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {inspect && (
              <>
                {inspect.filename} · {inspect.format.toUpperCase()} ·{' '}
                {inspect.totalRowsApprox.toLocaleString()} rows
              </>
            )}
          </div>
          <div className="flex gap-2">
            {step === 'configure' && (
              <Button variant="outline" onClick={() => setStep('upload')} disabled={busy}>
                Back
              </Button>
            )}
            {step === 'configure' && (
              <Button onClick={handleStart} disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Start import <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
            {(step === 'running' || step === 'done') && (
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────── step components ──────────────────────── */

function UploadStep(props: { busy: boolean; onFile: (f: File) => void; error: string | null }) {
  const [drag, setDrag] = useState(false);
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) props.onFile(f);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) props.onFile(f);
  }
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-12 text-center transition-colors ${
        drag ? 'border-primary bg-primary/5' : 'border-muted-foreground/30'
      }`}
    >
      {props.busy ? (
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
      ) : (
        <Upload className="h-10 w-10 text-muted-foreground" />
      )}
      <div>
        <div className="font-medium">Drop a CSV or XLSX file here</div>
        <div className="text-sm text-muted-foreground">
          We&apos;ll parse the first 1,000 rows to suggest column types.
        </div>
      </div>
      <label className="cursor-pointer">
        <input
          type="file"
          className="sr-only"
          accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm"
          onChange={onPick}
          disabled={props.busy}
        />
        <span className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted">
          <FileSpreadsheet className="h-4 w-4" />
          Choose file
        </span>
      </label>
      {props.error && (
        <div className="mt-2 text-sm text-destructive">
          <AlertTriangle className="mr-1 inline h-4 w-4" />
          {props.error}
        </div>
      )}
    </div>
  );
}

function ConfigureStep(props: {
  inspect: DataImportInspectResult;
  tables: TableInfo[];
  targetMode: 'existing' | 'new';
  setTargetMode: (m: 'existing' | 'new') => void;
  targetTable: string;
  setTargetTable: (s: string) => void;
  newTableName: string;
  setNewTableName: (s: string) => void;
  conflictMode: 'skip' | 'update' | 'fail';
  setConflictMode: (m: 'skip' | 'update' | 'fail') => void;
  conflictColumns: string[];
  setConflictColumns: (c: string[]) => void;
  mappings: MappingRow[];
  setMappings: (rows: MappingRow[] | ((prev: MappingRow[]) => MappingRow[])) => void;
  existingColumns: { name: string; type: string }[];
}) {
  const targetableColumns = useMemo(() => {
    if (props.targetMode === 'existing') return props.existingColumns.map((c) => c.name);
    return props.mappings.filter((m) => m.include).map((m) => m.target);
  }, [props.targetMode, props.existingColumns, props.mappings]);

  function updateMapping(idx: number, patch: Partial<MappingRow>) {
    props.setMappings((prev) => {
      const out = [...prev];
      out[idx] = { ...out[idx], ...patch };
      return out;
    });
  }

  function toggleConflictColumn(name: string, checked: boolean) {
    const next = checked
      ? [...props.conflictColumns, name]
      : props.conflictColumns.filter((n) => n !== name);
    props.setConflictColumns(next);
  }

  return (
    <div className="space-y-5">
      {/* Target picker */}
      <div className="space-y-2">
        <Label>Target table</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={props.targetMode === 'existing' ? 'default' : 'outline'}
            size="sm"
            onClick={() => props.setTargetMode('existing')}
          >
            Existing table
          </Button>
          <Button
            type="button"
            variant={props.targetMode === 'new' ? 'default' : 'outline'}
            size="sm"
            onClick={() => props.setTargetMode('new')}
          >
            Create new
          </Button>
        </div>
        {props.targetMode === 'existing' ? (
          <Select value={props.targetTable} onValueChange={props.setTargetTable}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a table…" />
            </SelectTrigger>
            <SelectContent>
              {props.tables.map((t) => (
                <SelectItem key={`${t.schema}.${t.name}`} value={t.name}>
                  {t.schema}.{t.name}{' '}
                  <span className="text-muted-foreground">({t.rowCount.toLocaleString()})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={props.newTableName}
            onChange={(e) => props.setNewTableName(sanitize(e.target.value))}
            placeholder="new_table_name"
          />
        )}
      </div>

      {/* Strategy */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>On duplicate row</Label>
          <Select value={props.conflictMode} onValueChange={(v) => props.setConflictMode(v as any)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip">Skip — keep existing row</SelectItem>
              <SelectItem value="update">Update — overwrite existing row</SelectItem>
              <SelectItem value="fail">Fail — error on conflict</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {props.conflictMode !== 'fail' && (
          <div className="space-y-2">
            <Label>Conflict columns (UNIQUE)</Label>
            <div className="max-h-24 overflow-y-auto rounded-md border p-2 text-sm">
              {targetableColumns.length === 0 ? (
                <div className="text-muted-foreground">Pick a target first.</div>
              ) : (
                targetableColumns.map((c) => (
                  <label key={c} className="flex items-center gap-2 py-0.5">
                    <Checkbox
                      checked={props.conflictColumns.includes(c)}
                      onCheckedChange={(v: boolean) => toggleConflictColumn(c, v)}
                    />
                    <span>{c}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Column mapping */}
      <div className="space-y-2">
        <Label>Columns ({props.mappings.filter((m) => m.include).length} of {props.mappings.length} included)</Label>
        <div className="rounded-md border">
          <div className="grid grid-cols-12 gap-2 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <div className="col-span-1">Use</div>
            <div className="col-span-3">Source</div>
            <div className="col-span-3">Target column</div>
            <div className="col-span-2">Type</div>
            <div className="col-span-1">Nullable</div>
            <div className="col-span-2">Sample</div>
          </div>
          <div className="max-h-[260px] overflow-y-auto">
            {props.mappings.map((m, i) => (
              <div key={`${m.source}-${i}`} className="grid grid-cols-12 items-center gap-2 border-b px-3 py-2 text-sm">
                <div className="col-span-1">
                  <Checkbox
                    checked={m.include}
                    onCheckedChange={(v: boolean) => updateMapping(i, { include: v })}
                  />
                </div>
                <div className="col-span-3 truncate" title={m.source}>{m.source}</div>
                <div className="col-span-3">
                  {props.targetMode === 'existing' ? (
                    <Select
                      value={m.target}
                      onValueChange={(v) => updateMapping(i, { target: v })}
                      disabled={!m.include || props.existingColumns.length === 0}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {props.existingColumns.map((c) => (
                          <SelectItem key={c.name} value={c.name}>
                            {c.name} <span className="text-muted-foreground">({c.type})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={m.target}
                      onChange={(e) => updateMapping(i, { target: sanitize(e.target.value) })}
                      disabled={!m.include}
                    />
                  )}
                </div>
                <div className="col-span-2">
                  <Select
                    value={m.type}
                    onValueChange={(v) => updateMapping(i, { type: v as DataImportColumnType })}
                    disabled={!m.include}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_OPTIONS.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-1 flex justify-center">
                  <Checkbox
                    checked={m.nullable}
                    onCheckedChange={(v: boolean) => updateMapping(i, { nullable: v })}
                    disabled={!m.include}
                  />
                </div>
                <div
                  className="col-span-2 truncate text-xs text-muted-foreground"
                  title={(props.inspect.inferredColumns.find((c) => c.originalName === m.source)?.sampleValues || []).join(' · ')}
                >
                  {(props.inspect.inferredColumns.find((c) => c.originalName === m.source)?.sampleValues || []).slice(0, 2).join(' · ') || '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunningStep(props: {
  percent: number;
  detail: string;
  rowsRead: number;
  rowsInserted: number;
  rowsBad: number;
}) {
  return (
    <div className="space-y-4 py-8 text-center">
      <Loader2 className="mx-auto h-10 w-10 animate-spin text-muted-foreground" />
      <div className="font-medium">{props.detail}</div>
      <div className="mx-auto w-full max-w-md">
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${Math.min(100, Math.max(0, props.percent))}%` }}
          />
        </div>
        <div className="mt-1 text-right text-xs text-muted-foreground">
          {Math.round(props.percent)}%
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-sm">
        <Stat label="Read" value={props.rowsRead} />
        <Stat label="Inserted" value={props.rowsInserted} />
        <Stat label="Errors" value={props.rowsBad} tone={props.rowsBad > 0 ? 'warn' : 'ok'} />
      </div>
      <p className="text-xs text-muted-foreground">
        Safe to close this dialog — the import keeps running in the background.
      </p>
    </div>
  );
}

function DoneStep(props: {
  projectId: string;
  jobId: string | null;
  result: DataImportResult | null;
  rowsRead: number;
  rowsInserted: number;
  rowsBad: number;
  error: string | null;
}) {
  const failed = !!props.error;
  return (
    <div className="space-y-4 py-6 text-center">
      {failed ? (
        <AlertTriangle className="mx-auto h-10 w-10 text-destructive" />
      ) : (
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
      )}
      <div className="font-medium">
        {failed ? 'Import failed' : 'Import complete'}
      </div>
      {props.error && <div className="text-sm text-destructive">{props.error}</div>}
      <div className="grid grid-cols-3 gap-2 text-center text-sm">
        <Stat label="Read" value={props.rowsRead} />
        <Stat label="Inserted" value={props.rowsInserted} />
        <Stat label="Errors" value={props.rowsBad} tone={props.rowsBad > 0 ? 'warn' : 'ok'} />
      </div>
      {props.result?.errorKey && props.jobId && (
        <a
          href={api.projects.downloadDataImportErrors(props.projectId, props.jobId)}
          download
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <Download className="h-4 w-4" />
          Download error report ({props.rowsBad.toLocaleString()} rows)
        </a>
      )}
    </div>
  );
}

function Stat(props: { label: string; value: number; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div
        className={`text-base font-semibold ${
          props.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''
        }`}
      >
        {props.value.toLocaleString()}
      </div>
      <div className="text-xs text-muted-foreground">{props.label}</div>
    </div>
  );
}

/* ──────────────────────── helpers ──────────────────────── */

function buildMappingRow(
  c: DataImportInferredColumn,
  defaultTarget: string,
): MappingRow {
  return {
    source: c.originalName,
    target: defaultTarget,
    type: c.type,
    nullable: c.nullable,
    include: true,
  };
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}


function Checkbox(props: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      checked={props.checked}
      onChange={(e) => props.onCheckedChange(e.target.checked)}
      disabled={props.disabled}
      className="h-4 w-4 rounded border-input accent-primary disabled:opacity-50"
    />
  );
}

// keep a referenced symbol to silence "imported but unused" if any of the
// icon imports ever become conditional in future edits.
void X;
