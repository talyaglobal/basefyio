'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '@/lib/api';
import type { ExportJobProgressEvent, ExportJobResult } from '@/lib/types';

const STORAGE_KEY = 'basefyio_active_exports';

export interface ActiveExport {
  jobId: string;
  projectId: string;
  projectName: string;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  state: string;
  progress?: ExportJobProgressEvent;
  result?: ExportJobResult;
  error?: string;
}

interface ExportProgressContextValue {
  activeExports: ActiveExport[];
  startTracking: (
    jobId: string,
    projectId: string,
    projectName: string,
    onComplete?: () => void,
  ) => void;
  dismiss: (jobId?: string) => void;
  modalShowingExport: boolean;
  setModalShowingExport: (v: boolean) => void;
  onReopenModal: (() => void) | null;
  setOnReopenModal: (fn: (() => void) | null) => void;
}

const ExportProgressContext = createContext<ExportProgressContextValue>({
  activeExports: [],
  startTracking: () => {},
  dismiss: () => {},
  modalShowingExport: false,
  setModalShowingExport: () => {},
  onReopenModal: null,
  setOnReopenModal: () => {},
});

export function useExportProgress() {
  return useContext(ExportProgressContext);
}

type PersistedExport = {
  jobId: string;
  projectId: string;
  projectName: string;
  startedAt: number;
};

function readPersisted(): PersistedExport[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PersistedExport =>
        !!x &&
        typeof x.jobId === 'string' &&
        typeof x.projectId === 'string' &&
        typeof x.projectName === 'string',
    );
  } catch {
    return [];
  }
}

function writePersisted(items: PersistedExport[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {}
}

export function ExportProgressProvider({ children }: { children: ReactNode }) {
  const [activeExports, setActiveExports] = useState<ActiveExport[]>([]);
  const [modalShowingExport, setModalShowingExport] = useState(false);
  const [onReopenModal, setOnReopenModalState] = useState<(() => void) | null>(null);
  const streamsRef = useRef<
    Record<string, { es: EventSource | null; timer: ReturnType<typeof setInterval> | null }>
  >({});
  const callbacksRef = useRef<Record<string, (() => void) | undefined>>({});
  const resumedRef = useRef(false);

  const setOnReopenModal = useCallback((fn: (() => void) | null) => {
    setOnReopenModalState(() => fn);
  }, []);

  const setExport = useCallback((jobId: string, patch: Partial<ActiveExport>) => {
    setActiveExports((prev) => {
      const idx = prev.findIndex((x) => x.jobId === jobId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, []);

  const persistRunning = useCallback((nextItems?: ActiveExport[]) => {
    const src = nextItems ?? activeExports;
    writePersisted(
      src
        .filter((x) => x.status === 'running')
        .map((x) => ({
          jobId: x.jobId,
          projectId: x.projectId,
          projectName: x.projectName,
          startedAt: x.startedAt,
        })),
    );
  }, [activeExports]);

  const stopTracking = useCallback((jobId: string) => {
    const item = streamsRef.current[jobId];
    if (!item) return;
    item.es?.close();
    if (item.timer) clearInterval(item.timer);
    delete streamsRef.current[jobId];
  }, []);

  const startTracking = useCallback((
    jobId: string,
    projectId: string,
    projectName: string,
    onComplete?: () => void,
  ) => {
    callbacksRef.current[jobId] = onComplete;
    setActiveExports((prev) => {
      if (prev.some((x) => x.jobId === jobId)) return prev;
      const next = [
        {
          jobId,
          projectId,
          projectName,
          startedAt: Date.now(),
          status: 'running' as const,
          state: 'waiting',
        },
        ...prev,
      ];
      writePersisted(
        next
          .filter((x) => x.status === 'running')
          .map((x) => ({
            jobId: x.jobId,
            projectId: x.projectId,
            projectName: x.projectName,
            startedAt: x.startedAt,
          })),
      );
      return next;
    });

    stopTracking(jobId);
    const es = api.projects.streamExportProgress(projectId, jobId, {
      onState: (state) => {
        setExport(jobId, { state, status: state === 'failed' ? 'failed' : undefined });
      },
      onProgress: (progress) => {
        setExport(jobId, { progress });
      },
      onCompleted: (result) => {
        setExport(jobId, {
          state: 'completed',
          status: 'completed',
          progress: { step: 'completed', detail: 'Export completed', percent: 100 },
          result,
          error: undefined,
        });
        callbacksRef.current[jobId]?.();
        persistRunning();
        stopTracking(jobId);
      },
      onFailed: (error) => {
        setExport(jobId, { state: 'failed', status: 'failed', error });
        persistRunning();
        stopTracking(jobId);
      },
      onError: () => {},
    });

    const timer = setInterval(async () => {
      try {
        const status = await api.projects.getExportStatus(projectId, jobId);
        if (!status) return;
        setExport(jobId, {
          state: status.state,
          progress: status.progress,
          ...(status.state === 'completed' && status.result
            ? {
                status: 'completed' as const,
                result: status.result,
                error: undefined,
              }
            : {}),
          ...(status.state === 'failed'
            ? {
                status: 'failed' as const,
                error: status.failedReason || 'Export failed',
              }
            : {}),
        });
        if (status.state === 'completed') {
          callbacksRef.current[jobId]?.();
          persistRunning();
          stopTracking(jobId);
        }
        if (status.state === 'failed') {
          persistRunning();
          stopTracking(jobId);
        }
      } catch {}
    }, 2000);

    streamsRef.current[jobId] = { es, timer };
  }, [persistRunning, setExport, stopTracking]);

  const dismiss = useCallback((jobId?: string) => {
    setActiveExports((prev) => {
      const next = jobId ? prev.filter((x) => x.jobId !== jobId) : prev.filter((x) => x.status === 'running');
      writePersisted(
        next
          .filter((x) => x.status === 'running')
          .map((x) => ({
            jobId: x.jobId,
            projectId: x.projectId,
            projectName: x.projectName,
            startedAt: x.startedAt,
          })),
      );
      return next;
    });
    if (jobId) {
      stopTracking(jobId);
      delete callbacksRef.current[jobId];
    }
  }, [stopTracking]);

  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    const persisted = readPersisted();
    persisted.forEach((x) => {
      startTracking(x.jobId, x.projectId, x.projectName);
    });
  }, [startTracking]);

  useEffect(() => {
    return () => {
      Object.values(streamsRef.current).forEach((x) => {
        x.es?.close();
        if (x.timer) clearInterval(x.timer);
      });
      streamsRef.current = {};
    };
  }, []);

  return (
    <ExportProgressContext.Provider
      value={{
        activeExports,
        startTracking,
        dismiss,
        modalShowingExport,
        setModalShowingExport,
        onReopenModal,
        setOnReopenModal,
      }}
    >
      {children}
    </ExportProgressContext.Provider>
  );
}

