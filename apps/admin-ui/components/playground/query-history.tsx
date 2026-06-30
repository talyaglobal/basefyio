'use client';

import { History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePlayground } from './playground-provider';

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function QueryHistory() {
  const { history, loadIntoEditor } = usePlayground();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-1 pb-1 text-xs font-medium text-muted-foreground">
        <History className="h-3.5 w-3.5" /> History
      </div>
      {history.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">Your run queries appear here.</p>
      ) : (
        history.map((h) => (
          <button
            key={h.id}
            type="button"
            onClick={() => loadIntoEditor(h.sql)}
            className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground"
            title={h.sql}
          >
            <div className="truncate font-mono text-xs">{oneLine(h.sql)}</div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className={cn(h.ok ? 'text-emerald-400' : 'text-destructive')}>
                {h.statusCode}
              </span>
              <span>{h.rowCount ?? 0} rows</span>
              <span>{h.durationMs}ms</span>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
