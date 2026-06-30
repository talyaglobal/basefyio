'use client';

import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { PlaygroundRunResult } from '@/lib/playground/engine';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './copy-button';
import { ResultTable, formatValue } from './result-table';

function StatusBadge({ code }: { code: number }) {
  const ok = code >= 200 && code < 300;
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono',
        ok
          ? 'border-emerald-500/40 text-emerald-400'
          : 'border-destructive/50 text-destructive',
      )}
    >
      {code} {ok ? 'OK' : 'Error'}
    </Badge>
  );
}

export function ResponseViewer({
  result,
  running,
}: {
  result: PlaygroundRunResult | null;
  running: boolean;
}) {
  const [view, setView] = useState<'table' | 'json'>('table');

  const json = useMemo(() => {
    if (!result) return '';
    if (!result.ok) return JSON.stringify({ statusCode: result.statusCode, error: result.error }, null, 2);
    return JSON.stringify(
      result.rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(row)) {
          const v = row[k];
          out[k] = v instanceof Date ? v.toISOString() : v;
        }
        return out;
      }),
      null,
      2,
    );
  }, [result]);

  if (running) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Run a query to see the response, execution time, and returned JSON.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <StatusBadge code={result.statusCode} />
          <span>{result.durationMs} ms</span>
          {result.ok && <span>{result.rowCount ?? 0} row{result.rowCount === 1 ? '' : 's'}</span>}
        </div>
        <div className="flex items-center gap-1">
          <div className="flex rounded-md border p-0.5">
            <Button
              variant={view === 'table' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setView('table')}
            >
              Table
            </Button>
            <Button
              variant={view === 'json' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setView('json')}
            >
              JSON
            </Button>
          </div>
          {result.ok && <CopyButton value={json} label="Copy JSON" />}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!result.ok ? (
          <pre className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {result.error}
          </pre>
        ) : view === 'json' ? (
          <pre className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">{json}</pre>
        ) : result.resultSets.length > 1 ? (
          <div className="space-y-4">
            {result.resultSets.map((rs, i) => (
              <div key={i} className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">
                  Statement {i + 1} · {rs.rowCount ?? 0} row{rs.rowCount === 1 ? '' : 's'}
                </div>
                <ResultTable fields={rs.fields} rows={rs.rows} />
              </div>
            ))}
          </div>
        ) : (
          <ResultTable fields={result.fields} rows={result.rows} />
        )}
      </div>
    </div>
  );
}

export { formatValue };
