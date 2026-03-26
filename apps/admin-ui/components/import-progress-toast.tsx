'use client';

import { useEffect, useRef, useState } from 'react';
import { useImportProgress } from '@/lib/import-progress-context';
import { Database, CheckCircle2, AlertTriangle, X, Loader2, Maximize2, Minus, ChevronUp } from 'lucide-react';

export function ImportProgressToast() {
  const { activeImport, dismiss, modalShowingImport, setModalShowingImport, onReopenModal } = useImportProgress();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (activeImport && (activeImport.status === 'completed' || activeImport.status === 'failed')) {
      setMinimized(false);
      timerRef.current = setTimeout(dismiss, 8000);
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }
  }, [activeImport?.status, dismiss]);

  useEffect(() => {
    if (!activeImport) setMinimized(false);
  }, [activeImport]);

  if (!activeImport || modalShowingImport) return null;

  const isRunning = activeImport.status === 'running';
  const isCompleted = activeImport.status === 'completed';
  const isFailed = activeImport.status === 'failed';
  const canClose = !isRunning;

  function handleOpenModal() {
    if (onReopenModal) {
      setModalShowingImport(true);
      onReopenModal();
    }
  }

  if (minimized && isRunning) {
    return (
      <div className="fixed bottom-4 right-4 z-[9999] animate-in slide-in-from-bottom-4 fade-in duration-300">
        <div
          className="flex items-center gap-2 rounded-full border bg-white/95 dark:bg-zinc-900/95 shadow-lg backdrop-blur-sm px-3 py-2 cursor-pointer hover:border-blue-400 dark:hover:border-blue-600 transition-colors"
          onClick={() => setMinimized(false)}
        >
          <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />
          <span className="text-xs font-medium">{activeImport.percent}%</span>
          <span className="text-xs text-muted-foreground truncate max-w-[120px]">
            {activeImport.projectName}
          </span>
          <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[9999] animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div
        className={`
          w-80 rounded-xl border shadow-lg backdrop-blur-sm transition-colors
          ${isCompleted ? 'bg-emerald-50/95 border-emerald-200 dark:bg-emerald-950/95 dark:border-emerald-800' : ''}
          ${isFailed ? 'bg-red-50/95 border-red-200 dark:bg-red-950/95 dark:border-red-800' : ''}
          ${isRunning ? 'bg-white/95 border-border dark:bg-zinc-900/95' : ''}
          ${onReopenModal && isRunning ? 'cursor-pointer hover:border-blue-400 dark:hover:border-blue-600' : ''}
        `}
        onClick={isRunning ? handleOpenModal : undefined}
      >
        <div className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {isRunning && <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />}
              {isCompleted && <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />}
              {isFailed && <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />}
              <span className="text-sm font-medium truncate">
                {isRunning && 'Importing...'}
                {isCompleted && 'Import Complete'}
                {isFailed && 'Import Failed'}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {isRunning && onReopenModal && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleOpenModal(); }}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5"
                  title="Open import details"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </button>
              )}
              {isRunning && (
                <button
                  onClick={(e) => { e.stopPropagation(); setMinimized(true); }}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5"
                  title="Minimize"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
              )}
              {canClose && (
                <button
                  onClick={(e) => { e.stopPropagation(); dismiss(); }}
                  className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5"
                  title="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            <Database className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground truncate">
              {activeImport.projectName}
            </span>
          </div>

          {isRunning && (
            <>
              <p className="text-xs text-muted-foreground mt-1.5 truncate">
                {activeImport.detail}
              </p>
              <div className="mt-2 w-full bg-muted rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${activeImport.percent}%` }}
                />
              </div>
              {onReopenModal && (
                <p className="text-[10px] text-muted-foreground/60 mt-1.5 text-center">
                  Click to open details
                </p>
              )}
            </>
          )}

          {isCompleted && activeImport.result && (
            <div className="mt-1.5 flex items-center gap-3 text-xs text-emerald-700 dark:text-emerald-400">
              <span>{activeImport.result.database.tables} tables</span>
              <span>{activeImport.result.auth.users} users</span>
              <span>{activeImport.result.storage.objects} files</span>
            </div>
          )}

          {isFailed && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1.5 line-clamp-2">
              {activeImport.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
