'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import type {
  BlueprintSummary,
  BlueprintDetail,
  BlueprintSheet,
  ProjectListItem,
  MigrationRun,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sparkles,
  Upload,
  Loader2,
  Trash2,
  CheckCircle2,
  ArrowLeft,
  Table2,
  Database,
} from 'lucide-react';

const MAX_SAMPLE_ROWS = 200;

async function parseSheets(file: File): Promise<BlueprintSheet[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheets: BlueprintSheet[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
    if (rows.length < 2) continue;
    const headers = (rows[0] as unknown[]).map((h) => String(h ?? ''));
    const dataRows = rows.slice(1, 1 + MAX_SAMPLE_ROWS) as unknown[][];
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !teamId) return;
    setAnalyzing(true);
    try {
      const sheets = await parseSheets(file);
      if (sheets.length === 0) {
        toast.error('No usable sheets found (need a header row + data)');
        return;
      }
      const bp = await api.blueprints.analyze({
        teamId,
        name: file.name.replace(/\.(xlsx|xls|csv)$/i, ''),
        sheets,
      });
      toast.success(`Analyzed ${sheets.length} sheet(s)`);
      await load();
      setSelectedId(bp.id);
    } catch (e: any) {
      toast.error(e?.message || 'Failed to analyze file');
    } finally {
      setAnalyzing(false);
    }
  };

  if (selectedId) {
    return (
      <BlueprintDetailView
        id={selectedId}
        teamId={teamId}
        onBack={() => {
          setSelectedId(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5 text-primary" /> App Builder
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
        <Button onClick={() => fileRef.current?.click()} disabled={analyzing || !teamId}>
          {analyzing ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-1 h-4 w-4" />
          )}
          New from Excel
        </Button>
      </div>

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
              onClick={() => setSelectedId(bp.id)}
              className="flex w-full items-center gap-3 rounded-lg border bg-card p-4 text-left hover:bg-accent"
            >
              <Database className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{bp.name}</div>
                <div className="text-xs text-muted-foreground">
                  {bp.domain ?? 'generic'} · {new Date(bp.createdAt).toLocaleDateString()}
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

function BlueprintDetailView({
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
      description: `Create ${bp?.dataModel.tables.length ?? 0} table(s) in the selected project's database? Existing tables with the same name are skipped.`,
      confirmText: 'Generate',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.blueprints.generate(bp!.id, targetProject);
      toast.success(`Generated: ${res.created} created, ${res.skipped} skipped`);
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
        <h2 className="text-sm font-medium text-muted-foreground">
          Data model ({bp.dataModel.tables.length} table{bp.dataModel.tables.length === 1 ? '' : 's'})
        </h2>
        {bp.dataModel.tables.map((t) => (
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
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
        {bp.status === 'DRAFT' && (
          <Button onClick={approve} disabled={busy}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            <CheckCircle2 className="mr-1 h-4 w-4" /> Approve
          </Button>
        )}
        {(bp.status === 'APPROVED' || bp.status === 'GENERATED' || bp.status === 'FAILED') && (
          <>
            <Select value={targetProject} onValueChange={setTargetProject}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select target project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={generate} disabled={busy || !targetProject}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              <Database className="mr-1 h-4 w-4" />
              {bp.status === 'GENERATED' ? 'Re-generate' : 'Generate tables'}
            </Button>
          </>
        )}
      </div>

      {/* Migrations — available once the blueprint has been generated */}
      {bp.status === 'GENERATED' && (
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
