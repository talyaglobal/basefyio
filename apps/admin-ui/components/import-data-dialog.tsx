'use client';

/**
 * Multi-step Import Data wizard.
 *
 * Lifecycle:
 *   1. upload   — user drops/selects a CSV/XLSX/JSON file, we hit POST /inspect
 *   2. configure — user reviews inferred schema, picks target (existing
 *                  table OR create new), conflict strategy, column mapping
 *                  and how values are read (encoding, number/date format)
 *   3. running  — streamed progress; the dialog can be closed while the
 *                  worker continues (job lives in BullMQ)
 *   4. done     — summary with read / inserted / updated / skipped / failed
 *                  rows, the first failed rows with their reasons, and the
 *                  full error report as a download
 *
 * Critical UX choices baked in:
 *   * Source columns the user doesn't want imported can be "skipped" — they
 *     just aren't included in the mapping array sent to /jobs. Into an
 *     existing table, columns that match nothing start out skipped.
 *   * Type overrides are user-editable on the preview step; the validator on
 *     the server respects whatever we send.
 *   * The plan is checked before Start (here and again on the server), so a
 *     mapping mistake is a message, not a job that dies halfway.
 *   * State resets each time the dialog opens — and only then, so refreshing
 *     the parent's table list after an import cannot wipe the summary.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, FileSpreadsheet, ArrowRight, Loader2, CheckCircle2, AlertTriangle, Download } from 'lucide-react';
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
  DataImportEncoding,
  DataImportInspectResult,
  DataImportInferredColumn,
  DataImportProgress,
  DataImportResult,
  DataImportValueFormat,
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

const ENCODING_OPTIONS: Array<{ value: DataImportEncoding | 'auto'; label: string }> = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'windows-1254', label: 'Windows-1254 (Turkish Excel)' },
  { value: 'iso-8859-9', label: 'ISO-8859-9 (Turkish)' },
  { value: 'windows-1252', label: 'Windows-1252 (Western European)' },
  { value: 'utf-16le', label: 'UTF-16 LE (Excel "Unicode text")' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
];

const ACCEPTED_EXTENSIONS = ['csv', 'tsv', 'txt', 'xlsx', 'xls', 'xlsm', 'json', 'ndjson', 'jsonl'];

/** Files above this size bypass the proxy and go straight to object storage. */
const PRESIGN_THRESHOLD_BYTES = 50 * 1024 * 1024;

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  /** Called to download a CSV template for the currently selected table. */
  onDownloadTemplate?: () => void;
}

interface MappingRow {
  source: string;
  target: string;
  type: DataImportColumnType;
  nullable: boolean;
  /** When false, the user has chosen to drop this column from the import. */
  include: boolean;
}

interface ExistingColumn {
  name: string;
  type: string;
  nullable: boolean;
  isPrimary: boolean;
  defaultValue: string | null;
}

type BatchEntry = {
  name: string;
  size: number;
  status: 'pending' | 'uploading' | 'ready' | 'error';
  sourceKey?: string;
  error?: string;
};

const fmtNumber = (n: number) => n.toLocaleString('en-US');

export function ImportDataDialog(props: ImportDataDialogProps) {
  const { open, onOpenChange, projectId, tables, defaultTargetTable, onCompleted } = props;

  const [step, setStep] = useState<WizardStep>('upload');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<DataImportInspectResult | null>(null);
  const [targetMode, setTargetMode] = useState<'existing' | 'new'>('existing');
  const [targetTable, setTargetTable] = useState<string>('');
  const [newTableName, setNewTableName] = useState<string>('');
  const [conflictMode, setConflictMode] = useState<'skip' | 'update' | 'fail'>('fail');
  const [conflictColumns, setConflictColumns] = useState<string[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [existingColumns, setExistingColumns] = useState<ExistingColumn[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DataImportProgress | null>(null);
  const [result, setResult] = useState<DataImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Drives the wizard's "First row is a header" checkbox. We keep it in sync
   *  with the inspect result; toggling re-inspects the already staged file. */
  const [firstRowIsHeader, setFirstRowIsHeader] = useState<boolean>(true);
  const [encoding, setEncoding] = useState<DataImportEncoding | 'auto'>('auto');
  const [valueFormat, setValueFormat] = useState<Required<DataImportValueFormat>>({
    decimalSeparator: '.',
    dateOrder: 'DMY',
    emptyAsNull: true,
    trimText: true,
  });
  const [reinspecting, setReinspecting] = useState(false);
  /** Bumped every time the dialog opens, so per-open effects re-run even when
   *  the target table is the same as last time. */
  const [session, setSession] = useState(0);
  /**
   * Multi-file batch state. When the user drops N files, the FIRST file's
   * inspect drives the schema/preview/mapping; the rest are staged silently
   * in MinIO and forwarded as `additionalSourceKeys` on Start. Per-file
   * upload status keeps the UI honest while big batches are being staged.
   */
  const [batchFiles, setBatchFiles] = useState<BatchEntry[]>([]);

  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  // Reset when the dialog OPENS — not whenever a prop changes. The parent
  // reloads its table list (and may change the selected table) when an import
  // finishes; resetting on that wiped the summary and showed an empty upload
  // screen.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep('upload');
      setBusy(false);
      setFile(null);
      setInspect(null);
      setTargetMode(defaultTargetTable ? 'existing' : 'new');
      setTargetTable(defaultTargetTable || '');
      setNewTableName('');
      setConflictMode('fail');
      setConflictColumns([]);
      setMappings([]);
      setExistingColumns([]);
      setJobId(null);
      setProgress(null);
      setResult(null);
      setError(null);
      setFirstRowIsHeader(true);
      setEncoding('auto');
      setValueFormat({ decimalSeparator: '.', dateOrder: 'DMY', emptyAsNull: true, trimText: true });
      setReinspecting(false);
      setBatchFiles([]);
      setSession((s) => s + 1);
    }
    wasOpen.current = open;
  }, [open, defaultTargetTable]);

  // When the user picks an existing table, fetch its columns so the mapping
  // selector knows what targets are available. `session` is a dependency so a
  // reopened dialog fetches again even for the same table — before, the reset
  // emptied the list but the fetch never re-ran, leaving free-text targets,
  // all-text types and "Pick a target first." until the user switched modes.
  const [columnsLoadFailed, setColumnsLoadFailed] = useState(false);
  useEffect(() => {
    if (targetMode !== 'existing' || !targetTable) {
      setExistingColumns([]);
      setColumnsLoadFailed(false);
      setColumnsLoading(false);
      return;
    }
    let cancelled = false;
    setColumnsLoadFailed(false);
    setColumnsLoading(true);
    api.projects
      .columns(projectId, targetTable)
      .then((cols) => {
        if (cancelled) return;
        // Carry through `nullable` from the DB so auto-map can flag NOT NULL
        // columns. Without this the wizard would default each mapping to
        // nullable=true and a single empty cell would crash the entire batch
        // INSERT with "violates not-null constraint".
        setExistingColumns(
          cols.map((c) => ({
            name: c.name,
            type: c.type,
            nullable: c.nullable,
            isPrimary: !!c.isPrimary,
            defaultValue: c.defaultValue ?? null,
          })),
        );
        if (cols.length === 0) {
          toast.error(`"${targetTable}" reports 0 columns. Type the target column names instead.`);
          setColumnsLoadFailed(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err?.message || 'Could not load table columns';
        toast.error(`Columns lookup failed: ${msg}`);
        setColumnsLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setColumnsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetMode, targetTable, projectId, session]);

  // Build mapping rows whenever the inspect result, target mode, or fetched
  // existingColumns change, and pick a sensible conflict strategy with them.
  useEffect(() => {
    if (!inspect) return;
    const existing = targetMode === 'existing' && existingColumns.length > 0 ? existingColumns : null;
    const byName = existing ? buildColumnLookup(existing) : null;

    const rows = inspect.inferredColumns.map((c) => {
      if (targetMode === 'new') {
        // A new table should not refuse empty cells just because the sample
        // had none; the user can still tick a column as required.
        return { ...buildMappingRow(c, c.name), nullable: true };
      }
      if (!byName) {
        // Columns could not be listed: fall back to the sanitized source name
        // in a free-text field (the server still checks it before starting).
        return buildMappingRow(c, c.name);
      }
      const matched = matchColumn(byName, c);
      if (!matched) {
        // Nothing to receive this column: leave it out rather than sending a
        // target the table does not have.
        return { ...buildMappingRow(c, ''), include: false };
      }
      // The DB's type and nullability are authoritative for an existing
      // column; casting to them up front turns a mismatch into a bad-row entry
      // instead of a failed batch.
      return {
        ...buildMappingRow(c, matched.name),
        type: pgTypeToImportType(matched.type),
        nullable: matched.nullable,
      };
    });
    setMappings(rows);

    // Existing table: its primary key is the natural conflict column when the
    // file carries it. Otherwise (and for new tables) plain inserts.
    const pk = existing ? existing.filter((c) => c.isPrimary).map((c) => c.name) : [];
    const mapped = new Set(rows.filter((r) => r.include).map((r) => r.target));
    if (pk.length > 0 && pk.every((k) => mapped.has(k))) {
      setConflictColumns(pk);
      setConflictMode('skip');
    } else {
      setConflictColumns([]);
      setConflictMode('fail');
    }
  }, [inspect, targetMode, existingColumns]);

  // Seed the number/date options from what the server detected.
  useEffect(() => {
    if (!inspect?.detectedFormat) return;
    const detected = inspect.detectedFormat;
    setValueFormat((prev) => ({
      ...prev,
      decimalSeparator: detected.decimalSeparator,
      dateOrder: detected.dateOrder,
    }));
  }, [inspect]);

  /**
   * Multi-file upload. The first file's /inspect drives schema detection; all
   * other files are staged via /inspect too (we need the sourceKey from
   * MinIO) but their schema results are discarded. We process them
   * sequentially rather than in parallel to keep memory + connection use
   * predictable when the user drops 50 files at once.
   */
  async function handleFileUpload(files: File[]) {
    if (files.length === 0) return;
    const unsupported = files.filter(
      (f) => !ACCEPTED_EXTENSIONS.includes(f.name.toLowerCase().split('.').pop() ?? ''),
    );
    if (unsupported.length > 0) {
      const msg = `Unsupported file type: ${unsupported.map((f) => f.name).join(', ')}. Use CSV, TSV, TXT, XLSX or JSON.`;
      setError(msg);
      toast.error(msg);
      return;
    }
    setBusy(true);
    setError(null);

    const initial: BatchEntry[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      status: 'pending',
    }));
    setBatchFiles(initial);

    const updateFile = (i: number, patch: Partial<BatchEntry>) =>
      setBatchFiles((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

    /**
     * Upload one file, choosing the best transport for its size.
     * Returns the InspectImportResultDto so the caller can drive the wizard.
     */
    const uploadOne = async (f: File): Promise<DataImportInspectResult> => {
      if (f.size <= PRESIGN_THRESHOLD_BYTES) {
        return api.projects.inspectDataImport(projectId, f, { firstRowIsHeader, encoding });
      }
      // Large file: presign → direct PUT → inspect-staged.
      const presign = await api.projects.presignDataImportUpload(projectId, f.name);
      // The browser uploads directly to MinIO. This bypasses Cloudflare,
      // the admin-ui Next route, and the platform-api Multer — none of
      // which see the bytes. MinIO does, and that's exactly its job.
      const putRes = await fetch(presign.uploadUrl, {
        method: 'PUT',
        body: f,
        headers: { 'Content-Type': f.type || 'application/octet-stream' },
      });
      if (!putRes.ok) {
        throw new Error(`Upload failed: ${putRes.status} ${putRes.statusText}`);
      }
      return api.projects.inspectStagedDataImport(projectId, {
        sourceKey: presign.sourceKey,
        filename: f.name,
        firstRowIsHeader,
        encoding,
      });
    };

    try {
      // First file: drive the wizard.
      updateFile(0, { status: 'uploading' });
      const firstInspect = await uploadOne(files[0]);
      updateFile(0, { status: 'ready', sourceKey: firstInspect.sourceKey });
      setFile(files[0]);
      setInspect(firstInspect);
      setFirstRowIsHeader(firstInspect.firstRowIsHeader);
      setStep('configure');

      // Remaining files: stage in the background so the wizard remains
      // interactive while uploads continue. The Start button checks
      // batchFiles for any remaining "uploading" entries and waits.
      for (let i = 1; i < files.length; i++) {
        updateFile(i, { status: 'uploading' });
        try {
          const r = await uploadOne(files[i]);
          updateFile(i, { status: 'ready', sourceKey: r.sourceKey });
        } catch (err: any) {
          updateFile(i, {
            status: 'error',
            error: err?.message || 'Upload failed',
          });
        }
      }
    } catch (e: any) {
      updateFile(0, { status: 'error', error: e?.message || 'Upload failed' });
      setError(e?.message || 'Upload failed');
      toast.error(e?.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-read the already staged first file with a different header or encoding
   * setting. Goes through inspect-staged, so nothing is uploaded again.
   */
  async function reinspect(next: { firstRowIsHeader?: boolean; encoding?: DataImportEncoding | 'auto' }) {
    const nextHeader = next.firstRowIsHeader ?? firstRowIsHeader;
    const nextEncoding = next.encoding ?? encoding;
    if (!inspect || !file) {
      setFirstRowIsHeader(nextHeader);
      setEncoding(nextEncoding);
      return;
    }
    setReinspecting(true);
    setError(null);
    try {
      const insp = await api.projects.inspectStagedDataImport(projectId, {
        sourceKey: inspect.sourceKey,
        filename: inspect.filename,
        firstRowIsHeader: nextHeader,
        encoding: nextEncoding,
      });
      setInspect(insp);
      setFirstRowIsHeader(insp.firstRowIsHeader);
      setEncoding(nextEncoding);
    } catch (e: any) {
      toast.error(e?.message || 'Could not read the file again');
    } finally {
      setReinspecting(false);
    }
  }

  const tableNameForPlan = targetMode === 'new' ? sanitize(newTableName) : targetTable;

  const planErrors = useMemo(
    () =>
      inspect
        ? validatePlan({
            targetMode,
            tableName: tableNameForPlan,
            mappings,
            existingColumns:
              targetMode === 'existing' && !columnsLoadFailed && existingColumns.length > 0
                ? existingColumns
                : null,
            conflictMode,
            conflictColumns,
          })
        : [],
    [inspect, targetMode, tableNameForPlan, mappings, existingColumns, columnsLoadFailed, conflictMode, conflictColumns],
  );

  async function handleStart() {
    if (!inspect) return;
    if (planErrors.length > 0) {
      toast.error(planErrors[0]);
      return;
    }
    const active = mappings.filter((m) => m.include && m.target);

    setBusy(true);
    setError(null);
    try {
      const tableName = tableNameForPlan;
      if (targetMode === 'new') setNewTableName(tableName);
      // Collect every successfully-staged file beyond the primary one.
      // Files still uploading are awaited via the validation below; files
      // that errored out are skipped (user already saw their toast).
      const stillUploading = batchFiles.some((b) => b.status === 'uploading');
      if (stillUploading) {
        toast.error('Some files are still uploading; please wait a moment.');
        setBusy(false);
        return;
      }
      const additionalSourceKeys = batchFiles
        .slice(1)
        .filter((b) => b.status === 'ready' && b.sourceKey)
        .map((b) => b.sourceKey as string);

      const { jobId: id } = await api.projects.startDataImport(projectId, {
        sourceKey: inspect.sourceKey,
        additionalSourceKeys: additionalSourceKeys.length ? additionalSourceKeys : undefined,
        filename: inspect.filename,
        format: inspect.format,
        firstRowIsHeader,
        encoding,
        valueFormat,
        targetMode,
        tableName,
        conflictMode,
        conflictColumns: conflictMode !== 'fail' && conflictColumns.length ? conflictColumns : undefined,
        columns: active.map((m) => ({
          source: m.source,
          target: sanitize(m.target),
          type: m.type,
          nullable: m.nullable,
        })),
      });
      setJobId(id);
      setProgress(null);
      setResult(null);
      setStep('running');
    } catch (e: any) {
      setError(e?.message || 'Start failed');
      toast.error(e?.message || 'Start failed');
    } finally {
      setBusy(false);
    }
  }

  // Follow the job once we have a jobId. The parent's callback is read through
  // a ref so a parent re-render does not tear the stream down.
  useEffect(() => {
    if (step !== 'running' || !jobId) return;
    const stream = api.projects.streamDataImportEvents(projectId, jobId, {
      onProgress: (p) => setProgress(p),
      onCompleted: (r) => {
        setResult(r);
        setStep('done');
        const bad = r.rowsBad ?? 0;
        const written = (r.rowsInserted ?? 0) + (r.rowsUpdated ?? 0);
        if ((r.rowsRead ?? 0) === 0) {
          toast.warning('Import finished, but the file had no data rows.');
        } else if (bad > 0) {
          toast.warning(
            `Import finished: ${fmtNumber(written)} rows written, ${fmtNumber(bad)} rows failed. See the error report.`,
            { duration: 8000 },
          );
        } else {
          toast.success(`Import finished: ${fmtNumber(written)} rows written.`);
        }
        onCompletedRef.current?.();
      },
      onFailed: (msg) => {
        setError(msg);
        setStep('done');
        toast.error(`Import failed: ${msg}`);
        // A failed "create new" import may have removed its table; refresh.
        onCompletedRef.current?.();
      },
    });
    return () => {
      stream.close();
    };
  }, [step, jobId, projectId]);

  const percent = progress?.percent ?? 0;
  const rowsRead = result?.rowsRead ?? progress?.rowsRead ?? 0;
  const rowsInserted = result?.rowsInserted ?? progress?.rowsInserted ?? 0;
  const rowsUpdated = result?.rowsUpdated ?? progress?.rowsUpdated ?? 0;
  const rowsBad = result?.rowsBad ?? progress?.rowsBad ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import data</DialogTitle>
          <DialogDescription>
            Upload a CSV, XLSX or JSON file, map its columns to a table, and run the import in the background.
          </DialogDescription>
        </DialogHeader>

        {step === 'upload' && (
          <UploadStep busy={busy} onFile={handleFileUpload} error={error} batchFiles={batchFiles} onDownloadTemplate={props.onDownloadTemplate} />
        )}

        {step === 'configure' && inspect && (
          <ConfigureStep
            inspect={inspect}
            tables={tables}
            firstRowIsHeader={firstRowIsHeader}
            onFirstRowIsHeaderChange={(v) => void reinspect({ firstRowIsHeader: v })}
            encoding={encoding}
            onEncodingChange={(v) => void reinspect({ encoding: v })}
            valueFormat={valueFormat}
            setValueFormat={setValueFormat}
            reinspecting={reinspecting}
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
            columnsLoading={columnsLoading}
            columnsLoadFailed={columnsLoadFailed}
            planErrors={planErrors}
          />
        )}

        {step === 'running' && (
          <RunningStep
            percent={percent}
            detail={progress?.detail || 'Starting…'}
            rowsRead={rowsRead}
            rowsInserted={rowsInserted}
            rowsUpdated={rowsUpdated}
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
            rowsUpdated={rowsUpdated}
            rowsBad={rowsBad}
            error={error}
            targetTable={targetMode === 'new' ? newTableName : targetTable}
            targetMode={targetMode}
            conflictMode={conflictMode}
            fileCount={batchFiles.length || 1}
          />
        )}

        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {inspect && (
              <>
                {/* Multi-file batch: surface the actual scope of the job
                    (file count, aggregate size, approximate total rows)
                    instead of just the first file's name. The first file's
                    count is extrapolated to the rest assuming equal size —
                    close enough for a status line. */}
                {batchFiles.length > 1
                  ? (() => {
                      const totalBytes = batchFiles.reduce((sum, b) => sum + b.size, 0);
                      const firstBytes = batchFiles[0]?.size || 1;
                      const approxTotalRows = Math.round(
                        inspect.totalRowsApprox * (totalBytes / firstBytes),
                      );
                      const sizeMb = (totalBytes / 1024 / 1024).toFixed(1);
                      return (
                        <>
                          {batchFiles.length} files · {inspect.format.toUpperCase()} · ~
                          {fmtNumber(approxTotalRows)} rows · {sizeMb} MB
                        </>
                      );
                    })()
                  : (
                      <>
                        {inspect.filename} · {inspect.format.toUpperCase()} ·{' '}
                        {inspect.totalRowsExact === false ? '~' : ''}
                        {fmtNumber(inspect.totalRowsApprox)} row{inspect.totalRowsApprox === 1 ? '' : 's'}
                      </>
                    )}
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
              <Button onClick={handleStart} disabled={busy || reinspecting || planErrors.length > 0}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Start import <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
            {step === 'done' && error && (
              // Failure path: let the user fix the plan (e.g. wrong conflict
              // columns, wrong table) without re-uploading. Inspect result,
              // mappings, staged sourceKeys, and target picks are all
              // preserved in component state. Once they hit Start again, a
              // fresh job is enqueued against the same staged files.
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  setJobId(null);
                  setProgress(null);
                  setResult(null);
                  setStep('configure');
                }}
              >
                Back to configure
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

function UploadStep(props: {
  busy: boolean;
  onFile: (files: File[]) => void;
  error: string | null;
  batchFiles: Array<{ name: string; size: number; status: string; error?: string }>;
  onDownloadTemplate?: () => void;
}) {
  const [drag, setDrag] = useState(false);
  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Allow picking the same file again after an error.
    e.target.value = '';
    if (files.length > 0) props.onFile(files);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDrag(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) props.onFile(files);
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
        <div className="font-medium">Drop CSV, XLSX or JSON file(s) here</div>
        <div className="text-sm text-muted-foreground">
          Multiple files allowed when they share the same schema. The first
          file drives column detection; the rest are queued under the same plan.
          Text files may be UTF-8 or a Turkish/Western Excel encoding — it is detected.
        </div>
      </div>
      <div className="flex items-center gap-3">
        <label className="cursor-pointer">
          <input
            type="file"
            multiple
            className="sr-only"
            accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm,.json,.ndjson,.jsonl"
            onChange={onPick}
            disabled={props.busy}
          />
          <span className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted">
            <FileSpreadsheet className="h-4 w-4" />
            Choose file(s)
          </span>
        </label>
        {props.onDownloadTemplate && (
          <button
            type="button"
            onClick={props.onDownloadTemplate}
            title="A header row plus one example row showing each column's format. Replace the example row before importing."
            className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Download className="h-4 w-4" />
            Download template
          </button>
        )}
      </div>
      {props.batchFiles.length > 0 && (
        <div className="mt-2 w-full max-w-md space-y-1 text-left text-xs">
          {props.batchFiles.map((b, i) => (
            <div
              key={`${b.name}-${i}`}
              className="flex items-center justify-between gap-2 rounded border bg-muted/20 px-2 py-1"
            >
              <span className="truncate" title={b.name}>
                {b.name} <span className="text-muted-foreground">({(b.size / 1024 / 1024).toFixed(1)} MB)</span>
              </span>
              <span
                className={
                  b.status === 'error'
                    ? 'text-destructive'
                    : b.status === 'ready'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-muted-foreground'
                }
              >
                {b.status === 'uploading' ? 'uploading…' : b.status === 'ready' ? '✓ staged' : b.status === 'error' ? (b.error || 'error') : 'queued'}
              </span>
            </div>
          ))}
        </div>
      )}
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
  firstRowIsHeader: boolean;
  onFirstRowIsHeaderChange: (next: boolean) => void;
  encoding: DataImportEncoding | 'auto';
  onEncodingChange: (next: DataImportEncoding | 'auto') => void;
  valueFormat: Required<DataImportValueFormat>;
  setValueFormat: (v: Required<DataImportValueFormat>) => void;
  reinspecting: boolean;
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
  existingColumns: ExistingColumn[];
  columnsLoading: boolean;
  columnsLoadFailed: boolean;
  planErrors: string[];
}) {
  const isText = props.inspect.format !== 'xlsx';
  const useColumnPicker = props.targetMode === 'existing' && props.existingColumns.length > 0;

  const targetableColumns = useMemo(() => {
    if (props.targetMode === 'existing' && props.existingColumns.length > 0) {
      return props.existingColumns.map((c) => c.name);
    }
    return props.mappings.filter((m) => m.include && m.target).map((m) => sanitize(m.target));
  }, [props.targetMode, props.existingColumns, props.mappings]);

  const fileHasId = props.mappings.some((m) => m.include && sanitize(m.target) === 'id');
  const warnings = props.inspect.warnings ?? [];

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
      {warnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          {warnings.map((w, i) => (
            <p key={i} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      {/* How the file is read. Header toggle and encoding re-read the staged
          file; number/date/text options apply when the rows are cast. */}
      <div className="space-y-3 rounded-md border bg-muted/30 px-3 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Checkbox
            id="import-header-row"
            checked={props.firstRowIsHeader}
            onCheckedChange={(v: boolean) => props.onFirstRowIsHeaderChange(v)}
            disabled={props.reinspecting}
          />
          <Label htmlFor="import-header-row" className="cursor-pointer select-none">
            First row is a header
          </Label>
          {props.reinspecting && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> re-reading…
            </span>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            Uncheck if the file has no header row.
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {isText && (
            <div className="space-y-1">
              <Label className="text-xs">Encoding</Label>
              <Select
                value={props.encoding}
                onValueChange={(v) => props.onEncodingChange(v as DataImportEncoding | 'auto')}
                disabled={props.reinspecting}
              >
                <SelectTrigger className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENCODING_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.value === 'auto' && props.inspect.encoding
                        ? `${o.label} (${props.inspect.encoding})`
                        : o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Numbers</Label>
            <Select
              value={props.valueFormat.decimalSeparator}
              onValueChange={(v) =>
                props.setValueFormat({ ...props.valueFormat, decimalSeparator: v as '.' | ',' })
              }
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value=".">1,234.56 (decimal point)</SelectItem>
                <SelectItem value=",">1.234,56 (decimal comma)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Dates</Label>
            <Select
              value={props.valueFormat.dateOrder}
              onValueChange={(v) =>
                props.setValueFormat({ ...props.valueFormat, dateOrder: v as 'DMY' | 'MDY' })
              }
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DMY">Day first — 31.12.2026, 31/12/2026</SelectItem>
                <SelectItem value="MDY">Month first — 12/31/2026</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Empty text cells</Label>
            <Select
              value={props.valueFormat.emptyAsNull ? 'null' : 'empty'}
              onValueChange={(v) =>
                props.setValueFormat({ ...props.valueFormat, emptyAsNull: v === 'null' })
              }
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="null">Store as NULL</SelectItem>
                <SelectItem value="empty">Store as an empty string</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="import-trim"
            checked={props.valueFormat.trimText}
            onCheckedChange={(v: boolean) => props.setValueFormat({ ...props.valueFormat, trimText: v })}
          />
          <Label htmlFor="import-trim" className="cursor-pointer select-none text-xs">
            Remove spaces around text values
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          ISO dates (2026-12-31) are always accepted, and a cell containing NULL is stored as NULL.
          Column types were detected with{' '}
          {props.inspect.detectedFormat?.decimalSeparator === ',' ? 'decimal commas' : 'decimal points'} and{' '}
          {props.inspect.detectedFormat?.dateOrder === 'MDY' ? 'month-first' : 'day-first'} dates; if you
          change the options above, check the types below.
        </p>
      </div>

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
                  <span className="text-muted-foreground">({fmtNumber(t.rowCount)})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="space-y-1">
            <Input
              value={props.newTableName}
              // Normalize lightly while typing and fully on blur: trimming
              // trailing underscores on every keystroke made "_" impossible to type.
              onChange={(e) => props.setNewTableName(sanitizeWhileTyping(e.target.value))}
              onBlur={(e) => props.setNewTableName(sanitize(e.target.value))}
              placeholder="new_table_name"
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits and underscores.{' '}
              {fileHasId
                ? 'The file has an id column, so it becomes the primary key.'
                : 'An auto-numbered id column is added as the primary key.'}
            </p>
          </div>
        )}
      </div>

      {/* Strategy */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>On duplicate row</Label>
          <Select value={props.conflictMode} onValueChange={(v) => props.setConflictMode(v as 'skip' | 'update' | 'fail')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fail">Insert — duplicates fail as row errors</SelectItem>
              <SelectItem value="skip">Skip — keep existing row</SelectItem>
              <SelectItem value="update">Update — overwrite existing row</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {props.conflictMode !== 'fail' && (
          <div className="space-y-2">
            <Label>{props.targetMode === 'new' ? 'Match rows on (gets a UNIQUE constraint)' : 'Match rows on (primary key or UNIQUE)'}</Label>
            <div className="max-h-24 overflow-y-auto rounded-md border p-2 text-sm">
              {targetableColumns.length === 0 ? (
                <div className="text-muted-foreground">
                  {props.targetMode === 'existing'
                    ? props.columnsLoading
                      ? 'Loading columns…'
                      : 'Pick a table first.'
                    : 'Include at least one column first.'}
                </div>
              ) : (
                targetableColumns.map((c) => {
                  const pk = props.existingColumns.find((e) => e.name === c)?.isPrimary;
                  return (
                    <label key={c} className="flex items-center gap-2 py-0.5">
                      <Checkbox
                        checked={props.conflictColumns.includes(c)}
                        onCheckedChange={(v: boolean) => toggleConflictColumn(c, v)}
                      />
                      <span>{c}</span>
                      {pk && <span className="text-[10px] uppercase text-muted-foreground">primary key</span>}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Column mapping */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>
            Columns ({props.mappings.filter((m) => m.include).length} of{' '}
            {props.mappings.length} included)
          </Label>
          {useColumnPicker && (
            // Quick action: align each source row with the existing column at
            // the same index. Skips auto-incrementing primary key columns
            // because the file almost never carries them. Saves the user from
            // clicking 23 dropdowns when source headers are garbled (e.g. a
            // header-less CSV) but the column order matches the table's.
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const candidates = props.existingColumns.filter(
                  (c) => !(c.isPrimary && c.defaultValue && /nextval\(|identity/i.test(c.defaultValue)),
                );
                props.setMappings((prev) =>
                  prev.map((m, i) => {
                    const col = candidates[i];
                    if (!col) return m;
                    return {
                      ...m,
                      target: col.name,
                      include: true,
                      type: pgTypeToImportType(col.type),
                      nullable: col.nullable,
                    };
                  }),
                );
              }}
            >
              Auto-map by position
            </Button>
          )}
        </div>
        {props.targetMode === 'existing' && useColumnPicker && props.mappings.some((m) => !m.include) && (
          <p className="text-xs text-muted-foreground">
            Columns with no matching column in the table start out unticked. Pick a target column to include them.
          </p>
        )}
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
                  {useColumnPicker ? (
                    <Select
                      value={m.target || undefined}
                      onValueChange={(v) => {
                        const col = props.existingColumns.find((c) => c.name === v);
                        updateMapping(i, {
                          target: v,
                          include: true,
                          ...(col ? { type: pgTypeToImportType(col.type), nullable: col.nullable } : {}),
                        });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Skip" />
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
                    // Free-text input when creating a new table, or when the
                    // existing table's columns could not be listed.
                    <Input
                      value={m.target}
                      onChange={(e) => updateMapping(i, { target: sanitizeWhileTyping(e.target.value) })}
                      onBlur={(e) => updateMapping(i, { target: sanitize(e.target.value) })}
                      disabled={!m.include}
                      placeholder={
                        props.targetMode === 'existing'
                          ? 'type column name…'
                          : 'new_column_name'
                      }
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

      {props.planErrors.length > 0 && (
        <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <p className="font-medium">Fix these before starting:</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {props.planErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RunningStep(props: {
  percent: number;
  detail: string;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
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
      <div className={`grid gap-2 text-center text-sm ${props.rowsUpdated > 0 ? 'grid-cols-4' : 'grid-cols-3'}`}>
        <Stat label="Read" value={props.rowsRead} />
        <Stat label="Inserted" value={props.rowsInserted} />
        {props.rowsUpdated > 0 && <Stat label="Updated" value={props.rowsUpdated} />}
        <Stat label="Failed" value={props.rowsBad} tone={props.rowsBad > 0 ? 'warn' : undefined} />
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
  rowsUpdated: number;
  rowsBad: number;
  error: string | null;
  targetTable: string;
  targetMode: 'existing' | 'new';
  conflictMode: 'skip' | 'update' | 'fail';
  fileCount: number;
}) {
  const [downloading, setDownloading] = useState(false);
  const failed = !!props.error;
  const r = props.result;
  const rowsSkipped = r?.rowsSkippedConflict ?? 0;
  const durationMs = r?.durationMs ?? 0;
  const written = props.rowsInserted + props.rowsUpdated;
  const partial = !failed && props.rowsBad > 0;
  const empty = !failed && props.rowsRead === 0;
  // Throughput is a useful sanity check: imports that look fast in absolute
  // numbers are sometimes choke-pointed on validation; rows/sec surfaces it.
  const throughput = durationMs > 0 ? Math.round((written / durationMs) * 1000) : 0;
  const successRate = props.rowsRead > 0 ? Math.round((written / props.rowsRead) * 1000) / 10 : 0;
  const sample = r?.badRowsSample ?? [];
  const multiFile = props.fileCount > 1;

  async function downloadReport() {
    if (!props.jobId) return;
    setDownloading(true);
    try {
      const { blob, filename } = await api.projects.fetchDataImportErrors(props.projectId, props.jobId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast.error(err?.message || 'Could not download the error report');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-5 py-4">
      {/* Header */}
      <div className="flex flex-col items-center gap-2 text-center">
        {failed ? (
          <AlertTriangle className="h-12 w-12 text-destructive" />
        ) : partial || empty ? (
          <AlertTriangle className="h-12 w-12 text-amber-500" />
        ) : (
          <CheckCircle2 className="h-12 w-12 text-emerald-500" />
        )}
        <div className="text-lg font-semibold">
          {failed
            ? 'Import failed'
            : empty
              ? 'Nothing to import'
              : partial
                ? 'Import finished with errors'
                : 'Import complete'}
        </div>
        {props.error && (
          <div className="max-w-md rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {props.error}
          </div>
        )}
        {(r?.warnings ?? []).map((w, i) => (
          <div
            key={i}
            className="max-w-md rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          >
            {w}
          </div>
        ))}
      </div>

      {/* Target + plan summary — what the user just did, at a glance. */}
      <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm">
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          <div className="text-muted-foreground">Target table</div>
          <div className="font-mono text-right">
            {props.targetTable}
            <span className="ml-1 text-xs text-muted-foreground">
              ({props.targetMode === 'new' ? (failed ? 'not created' : 'created') : 'existing'})
            </span>
          </div>
          <div className="text-muted-foreground">Source files</div>
          <div className="text-right">{fmtNumber(props.fileCount)}</div>
          <div className="text-muted-foreground">On duplicate row</div>
          <div className="text-right">{conflictModeLabel(props.conflictMode)}</div>
          {durationMs > 0 && (
            <>
              <div className="text-muted-foreground">Duration</div>
              <div className="text-right">{formatDuration(durationMs)}</div>
            </>
          )}
          {throughput > 0 && (
            <>
              <div className="text-muted-foreground">Throughput</div>
              <div className="text-right">{fmtNumber(throughput)} rows/sec</div>
            </>
          )}
        </div>
      </div>

      {/* Counters — only when rows were actually processed. */}
      {(r || props.rowsRead > 0) && (
        <div className={`grid gap-2 text-center text-sm ${props.conflictMode === 'update' ? 'grid-cols-5' : 'grid-cols-4'}`}>
          <Stat label="Read" value={props.rowsRead} />
          <Stat label="Inserted" value={props.rowsInserted} tone={props.rowsInserted > 0 ? 'ok' : undefined} />
          {props.conflictMode === 'update' && (
            <Stat label="Updated" value={props.rowsUpdated} tone={props.rowsUpdated > 0 ? 'info' : undefined} />
          )}
          <Stat label="Skipped (duplicate)" value={rowsSkipped} tone={rowsSkipped > 0 ? 'info' : undefined} />
          <Stat label="Failed" value={props.rowsBad} tone={props.rowsBad > 0 ? 'warn' : undefined} />
        </div>
      )}

      {/* Success rate bar — visual at a glance. */}
      {props.rowsRead > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Written vs. read</span>
            <span>{successRate.toLocaleString('en-US')}%</span>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${(written / props.rowsRead) * 100}%` }}
            />
            {rowsSkipped > 0 && (
              <div
                className="h-full bg-amber-300/70"
                style={{ width: `${(rowsSkipped / props.rowsRead) * 100}%` }}
              />
            )}
            {props.rowsBad > 0 && (
              <div
                className="h-full bg-destructive/70"
                style={{ width: `${(props.rowsBad / props.rowsRead) * 100}%` }}
              />
            )}
          </div>
        </div>
      )}

      {/* The failed rows themselves, so nothing is dropped silently. */}
      {sample.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Rows that were not imported
            {props.rowsBad > sample.length && (
              <span className="ml-1 font-normal text-muted-foreground">
                (first {sample.length} of {fmtNumber(props.rowsBad)})
              </span>
            )}
          </p>
          <div className="max-h-48 overflow-y-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/60 text-left text-muted-foreground">
                <tr>
                  {multiFile && <th className="px-2 py-1 font-medium">File</th>}
                  <th className="px-2 py-1 font-medium">Row</th>
                  <th className="px-2 py-1 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((b, i) => (
                  <tr key={i} className="border-t align-top">
                    {multiFile && <td className="px-2 py-1 tabular-nums">{b.file}</td>}
                    <td className="px-2 py-1 tabular-nums">{fmtNumber(b.row)}</td>
                    <td className="px-2 py-1 break-words">{b.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Row numbers count data rows; the header row is not counted.
          </p>
        </div>
      )}

      {/* Error report download — only when the worker captured bad rows. */}
      {r?.errorKey && props.jobId && props.rowsBad > 0 && (
        <div className="flex items-center justify-center">
          <Button variant="outline" onClick={() => void downloadReport()} disabled={downloading}>
            {downloading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
            Download error report ({fmtNumber(props.rowsBad)} row{props.rowsBad === 1 ? '' : 's'})
          </Button>
        </div>
      )}
    </div>
  );
}

function conflictModeLabel(mode: 'skip' | 'update' | 'fail'): string {
  switch (mode) {
    case 'skip':
      return 'Skip duplicates';
    case 'update':
      return 'Update existing rows';
    case 'fail':
      return 'Insert (duplicates fail)';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function Stat(props: { label: string; value: number; tone?: 'ok' | 'warn' | 'info' }) {
  const toneClass =
    props.tone === 'warn'
      ? 'text-amber-600 dark:text-amber-400'
      : props.tone === 'ok'
        ? 'text-emerald-600 dark:text-emerald-400'
        : props.tone === 'info'
          ? 'text-sky-600 dark:text-sky-400'
          : '';
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2">
      <div className={`text-base font-semibold ${toneClass}`}>{fmtNumber(props.value)}</div>
      <div className="text-xs text-muted-foreground">{props.label}</div>
    </div>
  );
}

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

/**
 * Letters with diacritics folded to ASCII (Turkish s-cedilla → "s", dotless
 * i → "i"), matching the server. Escapes keep the source ASCII-only.
 */
const TRANSLITERATION: Record<string, string> = {
  '\u015f': 's', '\u015e': 'S', '\u00e7': 'c', '\u00c7': 'C', '\u011f': 'g', '\u011e': 'G',
  '\u0131': 'i', '\u0130': 'I', '\u00f6': 'o', '\u00d6': 'O', '\u00fc': 'u', '\u00dc': 'U',
  '\u00df': 'ss',
};

function transliterate(s: string): string {
  return s
    .replace(/[\u015f\u015e\u00e7\u00c7\u011f\u011e\u0131\u0130\u00f6\u00d6\u00fc\u00dc\u00df]/g, (ch) => TRANSLITERATION[ch] ?? ch)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Light normalization while typing: keeps a trailing "_" so it can be typed. */
function sanitizeWhileTyping(s: string): string {
  return transliterate(s).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}

/** Full normalization (on blur and before starting): no leading/trailing "_". */
function sanitize(s: string): string {
  return transliterate(s)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, '_$1');
}

/** Lookup of existing columns by exact, lower-case and underscore-free name. */
function buildColumnLookup(cols: ExistingColumn[]): Map<string, ExistingColumn> {
  const map = new Map<string, ExistingColumn>();
  for (const c of cols) {
    for (const key of [c.name, c.name.toLowerCase(), c.name.toLowerCase().replace(/_/g, '')]) {
      if (!map.has(key)) map.set(key, c);
    }
  }
  return map;
}

function matchColumn(
  lookup: Map<string, ExistingColumn>,
  c: DataImportInferredColumn,
): ExistingColumn | null {
  const original = c.originalName.trim();
  const candidates = [
    original,
    original.toLowerCase(),
    c.name,
    c.name.toLowerCase(),
    c.name.replace(/_/g, ''),
  ];
  for (const key of candidates) {
    const hit = lookup.get(key);
    if (hit) return hit;
  }
  return null;
}

/** The same checks the server runs, so problems show up before Start. */
function validatePlan(input: {
  targetMode: 'existing' | 'new';
  tableName: string;
  mappings: MappingRow[];
  existingColumns: ExistingColumn[] | null;
  conflictMode: 'skip' | 'update' | 'fail';
  conflictColumns: string[];
}): string[] {
  const errors: string[] = [];
  if (input.targetMode === 'existing' && !input.tableName) {
    errors.push('Pick the table to import into.');
  }
  if (input.targetMode === 'new' && !input.tableName) {
    errors.push('Choose a name for the new table.');
  } else if (input.targetMode === 'new' && !IDENT_RE.test(input.tableName)) {
    errors.push(`"${input.tableName}" is not a valid table name.`);
  }

  const included = input.mappings.filter((m) => m.include);
  if (included.length === 0) errors.push('Include at least one column.');

  const seen = new Map<string, string>();
  for (const m of included) {
    const target = sanitize(m.target);
    if (!target) {
      errors.push(`Choose a target column for "${m.source}", or untick it.`);
      continue;
    }
    if (!IDENT_RE.test(target)) {
      errors.push(`"${target}" (from "${m.source}") is not a valid column name.`);
      continue;
    }
    if (input.existingColumns && !input.existingColumns.some((c) => c.name === target)) {
      errors.push(`Column "${target}" does not exist in the table — pick another target for "${m.source}", or untick it.`);
    }
    const prev = seen.get(target);
    if (prev !== undefined) {
      errors.push(`"${prev}" and "${m.source}" are both mapped to "${target}".`);
    }
    seen.set(target, m.source);
  }

  if (input.conflictMode !== 'fail') {
    if (input.conflictColumns.length === 0) {
      errors.push('Pick the column(s) that identify a duplicate row, or choose "Insert".');
    } else {
      const missing = input.conflictColumns.filter((c) => !seen.has(c));
      if (missing.length > 0) {
        errors.push(`Duplicate matching uses ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not imported.`);
      }
    }
  }
  return errors;
}

function pgTypeToImportType(pgType: string): DataImportColumnType {
  const t = pgType.toLowerCase();
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'smallint' || t === 'integer' || t === 'int' || t === 'int2' || t === 'int4')
    return 'integer';
  if (t === 'bigint' || t === 'int8') return 'bigint';
  if (
    t === 'numeric' ||
    t === 'decimal' ||
    t === 'real' ||
    t === 'float4' ||
    t === 'float8' ||
    t === 'double precision'
  )
    return 'numeric';
  if (t === 'uuid') return 'uuid';
  if (t === 'date') return 'date';
  if (
    t === 'timestamptz' ||
    t === 'timestamp with time zone' ||
    t === 'timestamp' ||
    t === 'timestamp without time zone'
  )
    return 'timestamptz';
  if (t === 'json' || t === 'jsonb') return 'jsonb';
  return 'text';
}

function Checkbox(props: {
  id?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <input
      id={props.id}
      type="checkbox"
      checked={props.checked}
      onChange={(e) => props.onCheckedChange(e.target.checked)}
      disabled={props.disabled}
      className="h-4 w-4 rounded border-input accent-primary disabled:opacity-50"
    />
  );
}
