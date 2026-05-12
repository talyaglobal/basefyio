'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ColumnInfo } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';

export interface DuplicateCleanerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  tableName: string;
  schema?: string;
  columns: ColumnInfo[];
  onCompleted: () => void;
}

export function DuplicateCleanerDialog({
  open,
  onOpenChange,
  projectId,
  tableName,
  schema,
  columns,
  onCompleted,
}: DuplicateCleanerDialogProps) {
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);

  const sortedColumns = useMemo(
    () => [...columns].sort((a, b) => a.name.localeCompare(b.name)),
    [columns],
  );

  useEffect(() => {
    if (!open) return;
    setPreviewCount(null);
    const pk = columns.filter((c) => c.isPrimary).map((c) => c.name);
    setSelectedCols(new Set(pk.length > 0 ? pk : []));
  }, [open, tableName, columns]);

  function toggleCol(name: string) {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
    setPreviewCount(null);
  }

  const keyList = useMemo(() => Array.from(selectedCols).sort(), [selectedCols]);

  async function runPreview() {
    if (keyList.length === 0) {
      toast.error('Select at least one column that defines a duplicate.');
      return;
    }
    setPreviewLoading(true);
    setPreviewCount(null);
    try {
      const res = await api.projects.deduplicateTableRows(
        projectId,
        tableName,
        { keyColumns: keyList, preview: true },
        schema,
      );
      setPreviewCount(res.rowsToDelete ?? 0);
    } catch (err: any) {
      toast.error(err.message || 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function runDeduplicate() {
    if (keyList.length === 0) {
      toast.error('Select at least one column that defines a duplicate.');
      return;
    }
    if (
      !confirm(
        'This permanently deletes extra duplicate rows from the database. ' +
          'One row is kept per duplicate group (largest internal row id). Continue?',
      )
    ) {
      return;
    }
    setRunLoading(true);
    try {
      const res = await api.projects.deduplicateTableRows(
        projectId,
        tableName,
        { keyColumns: keyList, preview: false },
        schema,
      );
      const n = res.deleted ?? 0;
      toast.success(n === 0 ? 'No duplicate rows to remove.' : `Removed ${n} duplicate row(s).`);
      onCompleted();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || 'Deduplicate failed');
    } finally {
      setRunLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle>Clean duplicate rows</DialogTitle>
          <DialogDescription className="text-left leading-relaxed">
            Choose which columns must match for two rows to count as duplicates (same logic as{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">DISTINCT ON</code> keys). NULL
            values match each other. One row per group is kept; extra rows are deleted. Works
            without a primary key (uses Postgres internal row ids). If another table references
            duplicate rows through a foreign key, the delete may fail until those references are
            resolved.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[min(52vh,22rem)] space-y-3 overflow-y-auto px-6 py-4">
          <p className="text-sm font-medium text-foreground">
            Table <span className="font-mono text-primary">{tableName}</span>
          </p>
          <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-xs font-medium text-muted-foreground">Key columns</p>
            <div className="flex flex-col gap-2">
              {sortedColumns.map((col) => (
                <label
                  key={col.name}
                  className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-input accent-primary"
                    checked={selectedCols.has(col.name)}
                    onChange={() => toggleCol(col.name)}
                  />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-mono font-medium">{col.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{col.type}</span>
                    {col.isPrimary ? (
                      <span className="ml-2 text-[10px] font-semibold uppercase text-primary">
                        PK
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </div>
          {previewCount !== null ? (
            <p className="text-sm text-muted-foreground">
              Preview:{' '}
              <span className="font-medium text-foreground">
                {previewCount.toLocaleString('en-US')}
              </span>{' '}
              row{previewCount === 1 ? '' : 's'} would be deleted.
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex flex-col gap-2 border-t border-border bg-muted/20 px-6 py-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={previewLoading || keyList.length === 0}
            onClick={() => void runPreview()}
          >
            {previewLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Preview…
              </>
            ) : (
              'Preview count'
            )}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={runLoading || keyList.length === 0}
            onClick={() => void runDeduplicate()}
          >
            {runLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Removing…
              </>
            ) : (
              'Remove duplicates'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
