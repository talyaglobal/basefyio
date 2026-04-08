'use client';

import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { api } from '@/lib/api';
import {
  normalizeImportProgressData,
  type ImportProgressData,
  type ImportJobProgressEvent,
} from '@/lib/types';
import { saveProjectSupabaseImportLog } from './import-log-storage';

const STORAGE_KEY = 'kolaybase_active_import';

export interface ActiveImport {
  jobId: string;
  projectName: string;
  /** Target project id (Supabase import enqueues a project before the job runs). */
  projectId?: string;
  /** Wall-clock start for ETA (persists across minimize / page refresh when possible). */
  startedAt: number;
  step: string;
  detail: string;
  percent: number;
  status: 'running' | 'completed' | 'failed';
  result?: ImportProgressData;
  error?: string;
  /** Active fetch strategy label (e.g. "PostgREST", "Direct SQL") */
  strategy?: string;
}

interface ImportProgressContextValue {
  activeImport: ActiveImport | null;
  startTracking: (
    jobId: string,
    projectName: string,
    onComplete?: () => void,
    startedAt?: number,
    projectId?: string,
  ) => void;
  cancelImport: () => Promise<void>;
  dismiss: () => void;
  modalShowingImport: boolean;
  setModalShowingImport: (v: boolean) => void;
  onReopenModal: (() => void) | null;
  setOnReopenModal: (fn: (() => void) | null) => void;
}

const ImportProgressContext = createContext<ImportProgressContextValue>({
  activeImport: null,
  startTracking: () => {},
  cancelImport: async () => {},
  dismiss: () => {},
  modalShowingImport: false,
  setModalShowingImport: () => {},
  onReopenModal: null,
  setOnReopenModal: () => {},
});

export function useImportProgress() {
  return useContext(ImportProgressContext);
}

function persistJob(
  jobId: string,
  projectName: string,
  startedAt: number,
  projectId?: string,
) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ jobId, projectName, startedAt, projectId }),
    );
  } catch {}
}

function clearPersistedJob() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function getPersistedJob(): {
  jobId: string;
  projectName: string;
  startedAt: number;
  projectId?: string;
} | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
      if (parsed?.jobId && parsed?.projectName) {
      return {
        jobId: parsed.jobId,
        projectName: parsed.projectName,
        startedAt:
          typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
        projectId: typeof parsed.projectId === 'string' ? parsed.projectId : undefined,
      };
    }
  } catch {}
  return null;
}

export function ImportProgressProvider({ children }: { children: ReactNode }) {
  const [activeImport, setActiveImport] = useState<ActiveImport | null>(null);
  const [modalShowingImport, setModalShowingImport] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompletedRef = useRef<((data: ImportProgressData) => void) | null>(null);
  const [onReopenModal, setOnReopenModalState] = useState<(() => void) | null>(null);
  const resumedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    setActiveImport(null);
    clearPersistedJob();
    stopPolling();
  }, [stopPolling]);

  const cancelImport = useCallback(async () => {
    const current = activeImportRef.current;
    if (!current || current.status !== 'running') return;

    try {
      await api.projects.cancelImport(current.jobId);
    } catch {}

    esRef.current?.close();
    esRef.current = null;
    stopPolling();
    setActiveImport(null);
    clearPersistedJob();
    setModalShowingImport(false);
  }, [stopPolling]);

  const activeImportRef = useRef(activeImport);
  activeImportRef.current = activeImport;

  const onCompleteCallbackRef = useRef<(() => void) | null>(null);

  const setOnReopenModal = useCallback((fn: (() => void) | null) => {
    setOnReopenModalState(() => fn);
  }, []);

  const startTracking = useCallback(
    (
      jobId: string,
      projectName: string,
      onComplete?: () => void,
      startedAt?: number,
      projectId?: string,
    ) => {
    esRef.current?.close();
    stopPolling();
    onCompleteCallbackRef.current = onComplete || null;

    const t0 = startedAt ?? Date.now();
    persistJob(jobId, projectName, t0, projectId);

    setActiveImport({
      jobId,
      projectName,
      ...(projectId ? { projectId } : {}),
      startedAt: t0,
      step: 'connect',
      detail: 'Connecting to Supabase...',
      percent: 0,
      status: 'running',
    });

    const handleCompleted = (data: any) => {
      try {
        const rawProgress = data?.progress ?? data?.result ?? data;
        const progress = normalizeImportProgressData(rawProgress);
        if (projectId) {
          try {
            saveProjectSupabaseImportLog(projectId, progress);
          } catch (saveErr) {
            console.warn('[import-progress] Failed to save import log to localStorage:', saveErr);
          }
        }
        setActiveImport((prev) => {
          if (!prev || prev.jobId !== jobId) return prev;
          return {
            ...prev,
            ...(projectId ? { projectId } : {}),
            step: 'completed',
            detail: 'Import complete',
            percent: 100,
            status: 'completed',
            result: progress,
          };
        });
        clearPersistedJob();
        stopPolling();
        onCompletedRef.current?.(progress);
        onCompleteCallbackRef.current?.();
      } catch (err) {
        console.error('[import-progress] Error in onCompleted handler:', err);
      }
    };

    const handleFailed = (error: string) => {
      setActiveImport((prev) => {
        if (!prev || prev.jobId !== jobId) return prev;
        return {
          ...prev,
          step: 'failed',
          detail: error,
          percent: prev.percent,
          status: 'failed',
          error,
        };
      });
      clearPersistedJob();
      stopPolling();
    };

    const es = api.projects.streamImportProgress(jobId, {
      onProgress: (data: ImportJobProgressEvent) => {
        setActiveImport((prev) => {
          if (!prev || prev.jobId !== jobId) return prev;
          return {
            ...prev,
            step: data.step,
            detail: data.detail,
            percent: data.percent || prev.percent,
            ...(data.strategy ? { strategy: data.strategy } : {}),
          };
        });
      },
      onCompleted: (data: any) => {
        handleCompleted(data);
        es.close();
      },
      onFailed: (error: string) => {
        handleFailed(error);
        es.close();
      },
    });

    esRef.current = es;

    pollRef.current = setInterval(async () => {
      const current = activeImportRef.current;
      if (!current || current.status !== 'running' || current.jobId !== jobId) {
        stopPolling();
        return;
      }
      try {
        const status = await api.projects.getImportJobStatus(jobId);
        if (!status) return;

        if (status.state === 'completed') {
          const resultData = status.result ?? status.progress;
          handleCompleted(resultData);
          esRef.current?.close();
          return;
        }

        if (status.state === 'failed') {
          handleFailed(status.failedReason || 'Import failed');
          esRef.current?.close();
          return;
        }

        if (status.progress && typeof status.progress === 'object') {
          const p = status.progress as any;
          if (p.step && p.detail) {
            setActiveImport((prev) => {
              if (!prev || prev.jobId !== jobId || prev.status !== 'running') return prev;
              const newPercent = p.percent ?? prev.percent;
              if (newPercent <= prev.percent && p.detail === prev.detail) return prev;
              return {
                ...prev,
                step: p.step,
                detail: p.detail,
                percent: newPercent,
                ...(p.strategy ? { strategy: p.strategy } : {}),
              };
            });
          }
        }
      } catch {
        // Polling error — SSE may still be working, ignore
      }
    }, 3000);
  }, [stopPolling]);

  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;

    const saved = getPersistedJob();
    if (!saved) return;

    startTracking(
      saved.jobId,
      saved.projectName,
      undefined,
      saved.startedAt,
      saved.projectId,
    );
  }, [startTracking]);

  return (
    <ImportProgressContext.Provider value={{
      activeImport, startTracking, cancelImport, dismiss, modalShowingImport, setModalShowingImport,
      onReopenModal, setOnReopenModal,
    }}>
      {children}
    </ImportProgressContext.Provider>
  );
}
