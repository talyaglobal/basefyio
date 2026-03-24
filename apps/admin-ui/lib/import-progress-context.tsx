'use client';

import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { api } from '@/lib/api';
import type { ImportProgressData, ImportJobProgressEvent } from '@/lib/types';

const STORAGE_KEY = 'kolaybase_active_import';

export interface ActiveImport {
  jobId: string;
  projectName: string;
  step: string;
  detail: string;
  percent: number;
  status: 'running' | 'completed' | 'failed';
  result?: ImportProgressData;
  error?: string;
}

interface ImportProgressContextValue {
  activeImport: ActiveImport | null;
  startTracking: (jobId: string, projectName: string, onComplete?: () => void) => void;
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

function persistJob(jobId: string, projectName: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId, projectName }));
  } catch {}
}

function clearPersistedJob() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function getPersistedJob(): { jobId: string; projectName: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.jobId && parsed?.projectName) return parsed;
  } catch {}
  return null;
}

export function ImportProgressProvider({ children }: { children: ReactNode }) {
  const [activeImport, setActiveImport] = useState<ActiveImport | null>(null);
  const [modalShowingImport, setModalShowingImport] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const onCompletedRef = useRef<((data: ImportProgressData) => void) | null>(null);
  const [onReopenModal, setOnReopenModalState] = useState<(() => void) | null>(null);
  const resumedRef = useRef(false);

  const dismiss = useCallback(() => {
    setActiveImport(null);
    clearPersistedJob();
  }, []);

  const cancelImport = useCallback(async () => {
    const current = activeImportRef.current;
    if (!current || current.status !== 'running') return;

    try {
      await api.projects.cancelImport(current.jobId);
    } catch {}

    esRef.current?.close();
    esRef.current = null;
    setActiveImport(null);
    clearPersistedJob();
    setModalShowingImport(false);
  }, []);

  const activeImportRef = useRef(activeImport);
  activeImportRef.current = activeImport;

  const onCompleteCallbackRef = useRef<(() => void) | null>(null);

  const setOnReopenModal = useCallback((fn: (() => void) | null) => {
    setOnReopenModalState(() => fn);
  }, []);

  const startTracking = useCallback((jobId: string, projectName: string, onComplete?: () => void) => {
    esRef.current?.close();
    onCompleteCallbackRef.current = onComplete || null;

    persistJob(jobId, projectName);

    setActiveImport({
      jobId,
      projectName,
      step: 'connect',
      detail: 'Connecting to Supabase...',
      percent: 0,
      status: 'running',
    });

    const es = api.projects.streamImportProgress(jobId, {
      onProgress: (data: ImportJobProgressEvent) => {
        setActiveImport((prev) => {
          if (!prev || prev.jobId !== jobId) return prev;
          return {
            ...prev,
            step: data.step,
            detail: data.detail,
            percent: data.percent || prev.percent,
          };
        });
      },
      onCompleted: (data: any) => {
        const progress: ImportProgressData = data.progress;
        setActiveImport((prev) => {
          if (!prev || prev.jobId !== jobId) return prev;
          return {
            ...prev,
            step: 'completed',
            detail: 'Import complete',
            percent: 100,
            status: 'completed',
            result: progress,
          };
        });
        clearPersistedJob();
        onCompletedRef.current?.(progress);
        onCompleteCallbackRef.current?.();
        es.close();
      },
      onFailed: (error: string) => {
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
        es.close();
      },
    });

    esRef.current = es;
  }, []);

  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;

    const saved = getPersistedJob();
    if (!saved) return;

    startTracking(saved.jobId, saved.projectName);
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
