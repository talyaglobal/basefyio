'use client';

import { useMemo } from 'react';
import { Loader2, Maximize2 } from 'lucide-react';
import { useExportProgress } from '@/lib/export-progress-context';

export function ExportProgressToast() {
  const {
    activeExports,
    setModalShowingExport,
    onReopenModal,
  } = useExportProgress();

  const running = useMemo(
    () => activeExports.filter((x) => x.status === 'running'),
    [activeExports],
  );

  // Keep toast visible whenever there are running exports.
  // Some route transitions can leave modal visibility flag stale.
  if (running.length === 0) return null;

  const head = running[0];

  return (
    <div className="fixed bottom-4 right-4 z-[9999] w-[340px] rounded-xl border bg-white/95 p-3 shadow-lg backdrop-blur-sm dark:bg-zinc-900/95">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Export queue running</p>
          <p className="text-xs text-muted-foreground">
            {running.length} active export{running.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              setModalShowingExport(true);
              onReopenModal?.();
            }}
            title="Open export status"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        {running.slice(0, 4).map((x) => (
          <div key={x.jobId} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{x.projectName}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {x.progress?.percent ?? 0}%
            </span>
          </div>
        ))}
        {running.length > 4 && (
          <p className="text-[11px] text-muted-foreground">+{running.length - 4} more in queue</p>
        )}
      </div>

      <button
        type="button"
        className="mt-2 w-full rounded-md border px-2 py-1.5 text-xs hover:bg-accent"
        onClick={() => {
          setModalShowingExport(true);
          onReopenModal?.();
        }}
      >
        Show export status
      </button>

      <p className="mt-1 text-center text-[10px] text-muted-foreground">
        Current: {head.projectName}
      </p>
    </div>
  );
}

