'use client';

import { useMemo, useState } from 'react';
import type { TableReconciliation } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, KeyRound, Minus } from 'lucide-react';

export function summarizeReconciliation(tables: TableReconciliation[]) {
  const mismatched = tables.filter((t) => t.rowCountMismatch).length;
  const keyless = tables.filter((t) => t.primaryKey === 'missing').length;
  const counted = tables.filter(
    (t) => t.sourceRows != null && t.sourceCountMethod !== 'rest-planned',
  ).length;
  const matching = tables.filter(
    (t) => t.sourceRows != null && t.sourceCountMethod !== 'rest-planned' && !t.rowCountMismatch,
  ).length;
  return { total: tables.length, mismatched, keyless, counted, matching };
}

type RowKind = 'mismatch' | 'estimated' | 'uncounted' | 'match';

function kindOf(t: TableReconciliation): RowKind {
  if (t.rowCountMismatch) return 'mismatch';
  if (t.sourceRows == null) return 'uncounted';
  if (t.sourceCountMethod === 'rest-planned') return 'estimated';
  return 'match';
}

/** Needs a person's attention: differs, keyless, or carries a note. */
function needsAttention(t: TableReconciliation): boolean {
  return t.rowCountMismatch || t.primaryKey === 'missing' || !!t.note;
}

const rank: Record<RowKind, number> = { mismatch: 0, uncounted: 1, estimated: 2, match: 3 };

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString();
}

export interface ImportReconciliationTableProps {
  tables: TableReconciliation[];
  /** Tighter rows and matching tables folded away by default. */
  compact?: boolean;
  /** Offered when a table has no primary key. */
  onRepairKeys?: () => void;
  className?: string;
}

/**
 * Table by table: what the source holds, what was sent, what is here.
 *
 * Differences come first, then tables without a key, then everything that
 * matched — folded away by default when there are many, since a long list of
 * green rows hides the one that matters.
 */
export function ImportReconciliationTable({
  tables,
  compact = false,
  onRepairKeys,
  className,
}: ImportReconciliationTableProps) {
  const summary = useMemo(() => summarizeReconciliation(tables), [tables]);
  const sorted = useMemo(
    () =>
      [...tables].sort((a, b) => {
        const attention = Number(needsAttention(b)) - Number(needsAttention(a));
        if (attention !== 0) return attention;
        const k = rank[kindOf(a)] - rank[kindOf(b)];
        if (k !== 0) return k;
        return a.table.localeCompare(b.table);
      }),
    [tables],
  );
  const foldable = compact || tables.length > 15;
  const [showAll, setShowAll] = useState(!foldable);
  const visible = showAll ? sorted : sorted.filter(needsAttention);
  const hidden = sorted.length - visible.length;

  return (
    <div className={cn('min-w-0 space-y-2', className)}>
      <div
        className={cn(
          'overflow-auto rounded-lg border',
          compact ? 'max-h-64' : 'max-h-80',
        )}
      >
        <table className="w-full min-w-[32rem] text-left text-xs">
          <thead className="sticky top-0 bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur-sm">
            <tr>
              <th className="px-3 py-2 font-medium">Table</th>
              <th className="px-3 py-2 text-right font-medium">Source</th>
              <th className="px-3 py-2 text-right font-medium">Imported</th>
              <th className="px-3 py-2 text-right font-medium">Here</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Key</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-center text-muted-foreground">
                  Every counted table matches the source.
                </td>
              </tr>
            )}
            {visible.map((t) => {
              const kind = kindOf(t);
              const diff =
                t.sourceRows != null && t.destinationRows != null
                  ? t.sourceRows - t.destinationRows
                  : null;
              return (
                <tr
                  key={t.table}
                  className={cn(
                    'border-t',
                    kind === 'mismatch' && 'bg-amber-50/70 dark:bg-amber-950/20',
                  )}
                >
                  <td className="px-3 py-1.5 font-mono text-[11px]">
                    <span className="break-all">{t.table}</span>
                    {t.note && (
                      <span className="block max-w-xs truncate text-[10px] text-muted-foreground" title={t.note}>
                        {t.note}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums" title={sourceTitle(t)}>
                    {kind === 'estimated' ? `~${fmt(t.sourceRows)}` : fmt(t.sourceRows)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(t.importedRows)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt(t.destinationRows)}</td>
                  <td className="px-3 py-1.5">
                    {kind === 'mismatch' && (
                      <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-400">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        {diff != null && diff > 0
                          ? `${diff.toLocaleString()} missing`
                          : diff != null
                            ? `${Math.abs(diff).toLocaleString()} extra`
                            : 'differs'}
                      </span>
                    )}
                    {kind === 'match' && (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3 w-3 shrink-0" />
                        match
                      </span>
                    )}
                    {kind === 'estimated' && (
                      <span className="text-muted-foreground">estimated</span>
                    )}
                    {kind === 'uncounted' && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <Minus className="h-3 w-3 shrink-0" />
                        source not counted
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {t.primaryKey === 'present' && (
                      <span className="inline-flex items-center gap-1 text-muted-foreground" title="Primary key present">
                        <KeyRound className="h-3 w-3 shrink-0" />
                        yes
                      </span>
                    )}
                    {t.primaryKey === 'added' && (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400" title="Primary key added by the repair">
                        <KeyRound className="h-3 w-3 shrink-0" />
                        added
                      </span>
                    )}
                    {t.primaryKey === 'missing' && (
                      <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-400" title="No primary key: a sync cannot match this table's rows">
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        none
                      </span>
                    )}
                    {t.primaryKey === 'unknown' && <span className="text-muted-foreground">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          {summary.counted > 0
            ? `${summary.matching} of ${summary.counted} counted table(s) match the source`
            : 'The source could not be counted'}
          {summary.keyless > 0 && (
            <>
              {' '}
              &middot;{' '}
              <span className="text-amber-800 dark:text-amber-400">
                {summary.keyless} without a primary key
              </span>
            </>
          )}
        </span>
        <span className="flex items-center gap-2">
          {foldable && hidden > 0 && (
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => setShowAll(true)}
            >
              Show {hidden} matching table(s)
            </button>
          )}
          {foldable && showAll && visible.length > 0 && hidden === 0 && sorted.some((t) => !needsAttention(t)) && (
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => setShowAll(false)}
            >
              Hide matching tables
            </button>
          )}
          {summary.keyless > 0 && onRepairKeys && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 border-amber-300/80 text-[11px] hover:bg-amber-100/80 dark:border-amber-800 dark:hover:bg-amber-950/40"
              onClick={onRepairKeys}
            >
              <KeyRound className="h-3 w-3" />
              Add missing primary keys
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

function sourceTitle(t: TableReconciliation): string {
  switch (t.sourceCountMethod) {
    case 'direct':
      return 'Counted over the direct database connection';
    case 'rest':
      return 'Exact count over the API (respects the source’s row-level security)';
    case 'rest-planned':
      return 'Planner estimate over the API: the exact count timed out';
    default:
      return 'The source could not be counted';
  }
}
