'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useImportProgress } from '@/lib/import-progress-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Database,
  Shield,
  HardDrive,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Minus,
} from 'lucide-react';
import {
  normalizeImportProgressData,
  type ImportProgressData,
  type ImportJobProgressEvent,
  type ProjectListItem,
} from '@/lib/types';
import { saveProjectSupabaseImportLog } from '@/lib/import-log-storage';

export interface ReimportTarget {
  projectId: string;
  projectName: string;
}

export type ReimportSource = 'supabase' | 'zip';

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  teamId: string;
  /** When set, opens re-import flow for this existing project. */
  reimportTarget?: ReimportTarget | null;
  reimportSource?: ReimportSource | null;
}

type DialogView = 'create' | 'import' | 'import-zip' | 'importing' | 'result';

interface ImportStep {
  key: string;
  label: string;
  icon: React.ReactNode;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

/** Cap so early % spikes do not produce absurd ETAs */
const MAX_IMPORT_ETA_MS = 45 * 60 * 1000;
/** Floor % for ETA math only — avoids divide-by-tiny-% blowups */
const MIN_PCT_FOR_ETA = 1;

/** Wall-clock countdown uses whole seconds; sub-minute shows live ticks without ~ */
function formatEtaTotalSeconds(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return 'Almost done…';
  if (totalSec < 6) return 'Almost done…';
  if (totalSec < 60) return `${totalSec}s remaining`;
  const mins = Math.floor(totalSec / 60);
  const remSec = totalSec % 60;
  return remSec > 0 ? `~${mins}m ${remSec}s remaining` : `~${mins}m remaining`;
}

function SupabaseLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 109 113" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627H99.1935C108.384 40.0627 113.406 50.7848 107.456 57.7107L63.7076 110.284Z" fill="url(#paint0_linear)"/>
      <path d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627H99.1935C108.384 40.0627 113.406 50.7848 107.456 57.7107L63.7076 110.284Z" fill="url(#paint1_linear)" fillOpacity="0.2"/>
      <path d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.04075L54.4849 72.2922H9.83113C0.641182 72.2922 -4.38119 61.5701 1.56878 54.6442L45.317 2.07103Z" fill="#3ECF8E"/>
      <defs>
        <linearGradient id="paint0_linear" x1="53.9738" y1="54.974" x2="94.1635" y2="71.8295" gradientUnits="userSpaceOnUse">
          <stop stopColor="#249361"/>
          <stop offset="1" stopColor="#3ECF8E"/>
        </linearGradient>
        <linearGradient id="paint1_linear" x1="36.1558" y1="30.578" x2="54.4844" y2="65.0806" gradientUnits="userSpaceOnUse">
          <stop/>
          <stop offset="1" stopOpacity="0"/>
        </linearGradient>
      </defs>
    </svg>
  );
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
  teamId,
  reimportTarget = null,
  reimportSource = null,
}: CreateProjectDialogProps) {
  const router = useRouter();
  const [view, setView] = useState<DialogView>('create');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [serviceRoleKey, setServiceRoleKey] = useState('');
  const [databasePassword, setDatabasePassword] = useState('');
  const [importName, setImportName] = useState('');
  const [importNameManual, setImportNameManual] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(false);
  const [tableCount, setTableCount] = useState(0);
  const [importSteps, setImportSteps] = useState<ImportStep[]>([]);
  const [importPercent, setImportPercent] = useState(0);
  const importStartRef = useRef<number>(0);
  const importPercentRef = useRef(0);
  const importEtaStartMsRef = useRef(0);
  const [importEta, setImportEta] = useState<string>('');
  const [importStrategy, setImportStrategy] = useState<string>('');
  const etaSmoothedMsRef = useRef(0);
  /** Wall-clock anchor so remaining time ticks down every real second (not smoothed lag). */
  const importEtaAnchorRef = useRef<{ at: number; remainingMs: number } | null>(null);
  const etaLastTickSecRef = useRef(-1);
  const etaRafRef = useRef<number | null>(null);

  const { activeImport, startTracking, cancelImport, setModalShowingImport, setOnReopenModal } =
    useImportProgress();
  const activeImportRef = useRef(activeImport);
  activeImportRef.current = activeImport;

  const [importResult, setImportResult] = useState<ImportProgressData | null>(null);
  const importResultHasIssues =
    !!importResult &&
    (importResult.warnings.length > 0 ||
      importResult.database.failedTables.length > 0 ||
      importResult.auth.skipped > 0);
  const [importProjectName, setImportProjectName] = useState('');
  const [importProjectId, setImportProjectId] = useState<string | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipImportMode, setZipImportMode] = useState<'duplicate' | 'override'>('duplicate');
  const [zipNameMode, setZipNameMode] = useState<'existing' | 'new'>('existing');
  const [zipNewName, setZipNewName] = useState('');
  const [zipExistingProjectId, setZipExistingProjectId] = useState('');
  const [teamProjects, setTeamProjects] = useState<ProjectListItem[]>([]);
  const [zipImporting, setZipImporting] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const dismissedDuringImportRef = useRef(false);
  /** True while the current job is a re-import (cancel must not delete project). */
  const reimportJobRef = useRef(false);

  const stopEtaAnimation = useCallback(() => {
    if (etaRafRef.current != null) {
      cancelAnimationFrame(etaRafRef.current);
      etaRafRef.current = null;
    }
    etaSmoothedMsRef.current = 0;
    importEtaAnchorRef.current = null;
    etaLastTickSecRef.current = -1;
    importEtaStartMsRef.current = 0;
  }, []);

  const runEtaFrame = useCallback(() => {
    const pct = importPercentRef.current;
    if (pct <= 0 || pct >= 100 || importEtaStartMsRef.current === 0) {
      etaRafRef.current = null;
      return;
    }

    const anchor = importEtaAnchorRef.current;
    const displayMs =
      anchor != null
        ? Math.max(0, anchor.remainingMs - (Date.now() - anchor.at))
        : Math.max(0, etaSmoothedMsRef.current);

    const tickSec = Math.max(0, Math.ceil(displayMs / 1000));
    if (tickSec !== etaLastTickSecRef.current) {
      etaLastTickSecRef.current = tickSec;
      setImportEta(formatEtaTotalSeconds(tickSec));
    }

    etaRafRef.current = requestAnimationFrame(runEtaFrame);
  }, []);

  const ensureEtaRaf = useCallback(() => {
    if (etaRafRef.current == null) {
      etaRafRef.current = requestAnimationFrame(runEtaFrame);
    }
  }, [runEtaFrame]);

  const updatePercentAndEta = useCallback(
    (pct: number) => {
      importPercentRef.current = pct;
      setImportPercent(pct);

      const ai = activeImportRef.current;
      const startMs =
        ai?.status === 'running' && ai.startedAt ? ai.startedAt : importStartRef.current;
      importEtaStartMsRef.current = startMs;

      if (pct <= 0 || pct >= 100 || startMs === 0) {
        stopEtaAnimation();
        setImportEta('');
        return;
      }

      const elapsed = Date.now() - startMs;
      const effectivePct = Math.max(pct, MIN_PCT_FOR_ETA);
      let raw = elapsed * (100 / effectivePct - 1);
      raw = Math.max(0, Math.min(raw, MAX_IMPORT_ETA_MS));

      const prev = etaSmoothedMsRef.current;
      let next: number;
      if (prev <= 0 || !Number.isFinite(prev)) {
        next = raw;
      } else if (raw < prev) {
        next = prev + (raw - prev) * 0.22;
      } else {
        next = prev + (raw - prev) * 0.04;
      }
      etaSmoothedMsRef.current = next;
      importEtaAnchorRef.current = { at: Date.now(), remainingMs: next };
      const secNow = Math.max(0, Math.ceil(next / 1000));
      etaLastTickSecRef.current = secNow;
      setImportEta(formatEtaTotalSeconds(secNow));

      ensureEtaRaf();
    },
    [stopEtaAnimation, ensureEtaRaf],
  );

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      stopEtaAnimation();
    };
  }, [stopEtaAnimation]);

  useEffect(() => {
    if (!open || !reimportTarget) return;

    const runningSameProject =
      activeImport?.status === 'running' &&
      reimportTarget.projectId === activeImport.projectId;

    if (runningSameProject) {
      setView('importing');
      setImportProjectName(activeImport.projectName);
      updatePercentAndEta(activeImport.percent);
      if (activeImport.strategy) setImportStrategy(activeImport.strategy);
      return;
    }

    if (reimportSource === 'zip') {
      setView('import-zip');
      setZipImportMode('override');
      setZipExistingProjectId(reimportTarget.projectId);
      setZipNameMode('existing');
      setZipNewName('');
      setZipFile(null);
      return;
    }

    setView('import');
    setImportName(reimportTarget.projectName);
    setImportNameManual(true);
    setValidated(false);
    setSupabaseUrl('');
    setServiceRoleKey('');
    setDatabasePassword('');
  }, [
    open,
    reimportTarget?.projectId,
    reimportTarget?.projectName,
    reimportSource,
    activeImport?.status,
    activeImport?.projectId,
    activeImport?.projectName,
    activeImport?.percent,
    activeImport?.strategy,
    updatePercentAndEta,
  ]);

  // Belt-and-suspenders: whenever the dialog closes with a running import,
  // ensure the toast becomes visible regardless of how the close happened.
  useEffect(() => {
    if (!open && activeImport?.status === 'running') {
      setModalShowingImport(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Register the reopen callback so the toast can reopen this dialog
  useEffect(() => {
    const reopenFn = () => {
      const current = activeImportRef.current;
      if (current && current.status === 'running') {
        setView('importing');
        setImportProjectName(current.projectName);
        updatePercentAndEta(current.percent);
        onOpenChange(true);
      }
    };

    setOnReopenModal(reopenFn);
    return () => setOnReopenModal(null);
  }, [onOpenChange, setOnReopenModal, updatePercentAndEta]);

  // Keep ETA / percent / strategy in sync while import runs (including when modal is minimized).
  useEffect(() => {
    if (!activeImport) return;
    if (activeImport.status === 'failed') {
      stopEtaAnimation();
      setImportEta('');
      importPercentRef.current = activeImport.percent;
      return;
    }
    updatePercentAndEta(activeImport.percent);
    if (activeImport.strategy) setImportStrategy(activeImport.strategy);
  }, [
    activeImport?.jobId,
    activeImport?.percent,
    activeImport?.status,
    activeImport?.startedAt,
    activeImport?.strategy,
    updatePercentAndEta,
    stopEtaAnimation,
  ]);

  // Sync import steps from the global context when modal is reopened (no local SSE)
  useEffect(() => {
    if (view !== 'importing' || !activeImport) return;
    if (eventSourceRef.current) return; // local SSE is active, skip

    if (activeImport.status === 'completed' && activeImport.result) {
      setImportResult(normalizeImportProgressData(activeImport.result));
      setImportProjectName(activeImport.projectName);
      if (activeImport.projectId) setImportProjectId(activeImport.projectId);
      setView('result');
      return;
    }

    if (activeImport.status !== 'running') return;

    const stepMap: Record<string, number> = { database: 1, auth: 2, storage: 3 };
    const currentStepIdx = stepMap[activeImport.step] ?? 0;

    setImportSteps([
      { key: 'connect', label: 'Connected to Supabase', icon: <Loader2 className="h-4 w-4" />, status: 'done' },
      { key: 'database', label: 'Importing Database', icon: <Database className="h-4 w-4" />, status: currentStepIdx > 1 ? 'done' : currentStepIdx === 1 ? 'active' : 'pending', detail: currentStepIdx === 1 ? activeImport.detail : undefined },
      { key: 'auth', label: 'Importing Auth Users', icon: <Shield className="h-4 w-4" />, status: currentStepIdx > 2 ? 'done' : currentStepIdx === 2 ? 'active' : 'pending', detail: currentStepIdx === 2 ? activeImport.detail : undefined },
      { key: 'storage', label: 'Importing Storage', icon: <HardDrive className="h-4 w-4" />, status: currentStepIdx === 3 ? 'active' : 'pending', detail: currentStepIdx === 3 ? activeImport.detail : undefined },
    ]);
  }, [
    view,
    activeImport?.step,
    activeImport?.percent,
    activeImport?.detail,
    activeImport?.status,
    activeImport?.result,
    activeImport?.projectId,
    activeImport?.projectName,
  ]);

  function resetState() {
    setView('create');
    setName('');
    setDescription('');
    setSupabaseUrl('');
    setServiceRoleKey('');
    setDatabasePassword('');
    setImportName('');
    setImportNameManual(false);
    setValidating(false);
    setValidated(false);
    setTableCount(0);
    setImportSteps([]);
    setImportPercent(0);
    importPercentRef.current = 0;
    setImportEta('');
    setImportStrategy('');
    importStartRef.current = 0;
    stopEtaAnimation();
    setImportResult(null);
    setImportProjectName('');
    setImportProjectId(null);
    setZipFile(null);
    setZipImportMode('duplicate');
    setZipNameMode('existing');
    setZipNewName('');
    setZipExistingProjectId('');
    setTeamProjects([]);
    setZipImporting(false);
    setLoading(false);
    setCancelling(false);
    dismissedDuringImportRef.current = false;
    reimportJobRef.current = false;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }

  async function handleValidateSupabase() {
    if (!supabaseUrl.trim() || !serviceRoleKey.trim()) return;
    setValidating(true);
    setValidated(false);
    try {
      const result = await api.projects.validateSupabase(
        supabaseUrl.replace(/\/+$/, ''),
        serviceRoleKey,
      );
      setValidated(true);
      setTableCount(result.tableCount);
      if (!importNameManual && result.projectName) {
        setImportName(result.projectName);
      }
      toast.success(`Connected! Found ${result.tableCount} tables.`);
    } catch (err: any) {
      toast.error(err.message || 'Connection failed');
      setValidated(false);
    } finally {
      setValidating(false);
    }
  }

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) {
      if (view === 'importing') {
        dismissedDuringImportRef.current = true;
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        setModalShowingImport(false);
        onOpenChange(false);
        return;
      }
      resetState();
    }
    onOpenChange(isOpen);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const project = await api.projects.create({
        name,
        description: description || undefined,
        teamId,
      });
      toast.success(`Project "${project.name}" created`);
      resetState();
      onCreated();
      onOpenChange(false);
      router.push(`/dashboard/projects/${project.id}`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  function updateStepFromSSE(data: ImportJobProgressEvent) {
    updatePercentAndEta(data.percent || 0);
    if (data.strategy) setImportStrategy(data.strategy);

    setImportSteps((prev) => {
      const steps = [...prev];
      if (data.step === 'completed') {
        return steps.map((step) => ({
          ...step,
          status: 'done',
          detail: step.detail,
        }));
      }
      if (data.step === 'failed') {
        const activeIdx = steps.findIndex(
          (step) => step.status === 'active' || step.status === 'pending',
        );
        if (activeIdx >= 0) {
          steps[activeIdx] = {
            ...steps[activeIdx],
            status: 'error',
            detail: data.error || data.detail,
          };
        }
        return steps;
      }
      const stepMap: Record<string, number> = {
        database: 1,
        auth: 2,
        storage: 3,
      };

      const idx = stepMap[data.step];
      if (idx === undefined) return steps;

      // Mark previous steps as done
      for (let i = 0; i < idx; i++) {
        if (steps[i] && steps[i].status !== 'done') {
          steps[i] = { ...steps[i], status: 'done' };
        }
      }

      // Update current step
      if (steps[idx]) {
        steps[idx] = {
          ...steps[idx],
          status: 'active',
          detail: data.detail,
        };
      }

      // Mark connect step as done once any other step starts
      if (steps[0] && steps[0].status !== 'done') {
        steps[0] = { ...steps[0], status: 'done', label: 'Connected to Supabase' };
      }

      return steps;
    });
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    dismissedDuringImportRef.current = false;
    reimportJobRef.current = !!reimportTarget;
    setView('importing');

    const steps: ImportStep[] = [
      { key: 'connect', label: 'Connecting to Supabase', icon: <Loader2 className="h-4 w-4" />, status: 'active' },
      { key: 'database', label: 'Importing Database', icon: <Database className="h-4 w-4" />, status: 'pending' },
      { key: 'auth', label: 'Importing Auth Users', icon: <Shield className="h-4 w-4" />, status: 'pending' },
      { key: 'storage', label: 'Importing Storage', icon: <HardDrive className="h-4 w-4" />, status: 'pending' },
    ];
    setImportSteps(steps);
    importStartRef.current = Date.now();

    try {
      const result = await api.projects.importFromSupabase({
        supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
        serviceRoleKey,
        ...(databasePassword.trim() ? { databasePassword: databasePassword.trim() } : {}),
        name: reimportTarget?.projectName ?? importName,
        teamId,
        ...(reimportTarget
          ? { existingProjectId: reimportTarget.projectId }
          : {}),
      });

      setImportProjectName(result.project.name);
      setImportProjectId(result.project.id);

      // Always start global tracking so the job is persisted and the context SSE runs.
      startTracking(
        result.jobId,
        result.project.name,
        onCreated,
        importStartRef.current,
        result.project.id,
      );

      // Only mark the modal as "showing import" if the dialog wasn't dismissed
      // while the API call was in-flight (race condition guard).
      if (!dismissedDuringImportRef.current) {
        setModalShowingImport(true);
      }

      // Local SSE is only needed while the modal is open.
      if (dismissedDuringImportRef.current) return;

      const es = api.projects.streamImportProgress(result.jobId, {
        onState: (state) => {
          if (state === 'waiting' || state === 'delayed') {
            setImportSteps((prev) => {
              const s = [...prev];
              if (s[0] && s[0].status === 'active') {
                s[0] = { ...s[0], detail: 'Queued, waiting for worker...' };
              }
              return s;
            });
          } else if (state === 'active') {
            setImportSteps((prev) => {
              const s = [...prev];
              if (s[0] && s[0].status === 'active') {
                s[0] = { ...s[0], detail: 'Worker picked up job...' };
              }
              return s;
            });
          }
        },
        onProgress: (data) => {
          updateStepFromSSE(data);
        },
        onCompleted: (data) => {
          const rawProgress = data?.progress ?? data?.result ?? data;
          const progress = normalizeImportProgressData(rawProgress);

          if (result.project.id) {
            try {
              saveProjectSupabaseImportLog(result.project.id, progress);
            } catch {}
          }

          setImportSteps((prev) => {
            const s = [...prev];
            s[0] = { ...s[0], status: 'done', label: 'Connected to Supabase' };
            s[1] = { ...s[1], status: 'done', detail: `${progress.database.tables} tables, ${progress.database.rows} rows` };
            s[2] = { ...s[2], status: 'done', detail: `${progress.auth.users} users` };
            s[3] = { ...s[3], status: 'done', detail: `${progress.storage.buckets} buckets, ${progress.storage.objects} objects` };
            return s;
          });
          updatePercentAndEta(100);
          setImportResult(progress);
          setView('result');
          const hasIssues =
            progress.warnings.length > 0 ||
            progress.database.failedTables.length > 0 ||
            progress.auth.skipped > 0;
          const listed = progress.warnings.length;
          if (hasIssues) {
            toast.warning(
              listed > 0
                ? `Import finished with ${listed} message${listed === 1 ? '' : 's'}. See the list in the dialog.`
                : 'Import finished with some issues. See the dialog for details.',
              { duration: 8000 },
            );
          } else {
            toast.success(
              reimportTarget
                ? `Re-import completed for "${result.project.name}"`
                : `Project "${result.project.name}" imported from Supabase`,
            );
          }
          onCreated();
        },
        onFailed: (error) => {
          stopEtaAnimation();
          setImportEta('');
          importPercentRef.current = 0;
          setImportSteps((prev) => {
            const s = [...prev];
            const activeIdx = s.findIndex((st) => st.status === 'active' || st.status === 'pending');
            if (activeIdx >= 0) {
              s[activeIdx] = { ...s[activeIdx], status: 'error', detail: error };
            }
            return s;
          });
          toast.error(`Import failed: ${error}`);
          setView('import');
        },
      });

      eventSourceRef.current = es;
    } catch (err: any) {
      stopEtaAnimation();
      setImportEta('');
      importPercentRef.current = 0;
      setImportSteps((prev) => {
        const s = [...prev];
        s[0] = { ...s[0], status: 'error', detail: err.message };
        return s;
      });
      toast.error(`Import failed: ${err.message}`);
      setView('import');
    }
  }

  async function handleImportExportZip(e: React.FormEvent) {
    e.preventDefault();
    if (!zipFile) {
      toast.error('Please select an export ZIP file.');
      return;
    }
    if (zipImportMode === 'override' && !zipExistingProjectId.trim()) {
      toast.error('Please select a project to override.');
      return;
    }

    if (zipImportMode === 'duplicate' && zipNameMode === 'new' && !zipNewName.trim()) {
      toast.error('Please enter a new project name.');
      return;
    }

    setZipImporting(true);
    try {
      const result = await api.projects.importFromExportZip({
        file: zipFile,
        teamId,
        nameMode: zipNameMode,
        newProjectName: zipNameMode === 'new' ? zipNewName.trim() : undefined,
        existingProjectId:
          zipImportMode === 'override' ? zipExistingProjectId : undefined,
      });

      if (result.warnings.length > 0) {
        toast.warning(
          `ZIP import completed with ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}.`,
        );
      } else {
        toast.success(`Project "${result.project.name}" imported from ZIP.`);
      }
      resetState();
      onCreated();
      onOpenChange(false);
      router.push(`/dashboard/projects/${result.project.id}`);
    } catch (err: any) {
      toast.error(err.message || 'ZIP import failed');
    } finally {
      setZipImporting(false);
    }
  }

  useEffect(() => {
    if (!open || (view !== 'import' && view !== 'import-zip')) return;
    api.projects
      .list(teamId)
      .then((items) => {
        setTeamProjects(items);
        if (!zipExistingProjectId && items.length > 0) {
          setZipExistingProjectId(items[0].id);
        }
      })
      .catch(() => {
        setTeamProjects([]);
      });
  }, [open, view, teamId, zipExistingProjectId]);

  function handleResultDone() {
    const targetId = importProjectId || activeImport?.projectId || null;
    const result = importResult;

    if (targetId && result) {
      try {
        saveProjectSupabaseImportLog(targetId, result);
      } catch {
        // localStorage might be unavailable
      }
    }

    setModalShowingImport(false);
    resetState();
    onCreated();
    onOpenChange(false);

    if (targetId) {
      router.push(`/dashboard/projects/${targetId}`);
    } else {
      router.push('/dashboard/projects');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" hideClose={view === 'importing'}>
        {view === 'create' && (
          <>
            <DialogHeader>
              <DialogTitle>Create Project</DialogTitle>
              <DialogDescription>
                A new database and authentication realm will be provisioned
                automatically.
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="project-name">Project Name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-app"
                  required
                  minLength={2}
                  maxLength={64}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="project-desc">Description (optional)</Label>
                <Input
                  id="project-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A short description"
                  maxLength={256}
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={loading || !name.trim()}>
                  {loading ? 'Creating...' : 'Create Project'}
                </Button>
              </DialogFooter>
            </form>

            <div className="relative my-2">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
                or
              </span>
            </div>

            <button
              type="button"
              onClick={() => setView('import')}
              className="w-full flex items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700 transition-all hover:border-emerald-400 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400 dark:hover:border-emerald-600 dark:hover:bg-emerald-950/50"
            >
              <SupabaseLogo className="h-5 w-5" />
              Import from Supabase
            </button>
            <button
              type="button"
              onClick={() => setView('import-zip')}
              className="mt-2 w-full flex items-center justify-center gap-2.5 rounded-lg border-2 border-dashed border-blue-300 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700 transition-all hover:border-blue-400 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/30 dark:text-blue-400 dark:hover:border-blue-600 dark:hover:bg-blue-950/50"
            >
              <HardDrive className="h-5 w-5" />
              Import from ZIP
            </button>
          </>
        )}

        {view === 'import' && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    reimportTarget ? handleOpenChange(false) : setView('create')
                  }
                  className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={reimportTarget ? 'Close' : 'Back'}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="flex items-center gap-2">
                  <SupabaseLogo className="h-5 w-5" />
                  <DialogTitle>
                    {reimportTarget
                      ? 'Re-import from Supabase'
                      : 'Import from Supabase'}
                  </DialogTitle>
                </div>
              </div>
              <DialogDescription>
                {reimportTarget ? (
                  <>
                    Pull data again from your Supabase project into{' '}
                    <span className="font-medium text-foreground">
                      {reimportTarget.projectName}
                    </span>
                    . Existing imported tables in basefyio are replaced when
                    names match; auth and storage are synced again.
                  </>
                ) : (
                  <>
                    Clone a Supabase project including database, auth users, and
                    storage files.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            {reimportTarget && (
              <div className="rounded-lg border border-emerald-200/80 bg-emerald-50/80 px-3 py-2.5 text-xs text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
                <p className="font-semibold text-emerald-900 dark:text-emerald-200">
                  Fewer errors and warnings
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-emerald-900/90 dark:text-emerald-200/90">
                  <li>
                    Use the <strong>service_role</strong> key (Supabase → Settings → API),
                    not the anon key, so the importer can read all tables.
                  </li>
                  <li>
                    If some tables still show 0 rows or permission errors, add the{' '}
                    <strong>Database password</strong> (Settings → Database) so basefyio
                    can copy data over a direct Postgres connection.
                  </li>
                  <li>
                    Match the <strong>Supabase project URL</strong> to the same source you
                    used before if you want a true refresh; a different project will
                    replace data with that project&apos;s schema and rows.
                  </li>
                  <li>
                    Large projects take several minutes; keep this window open or use the
                    progress toast if you minimize.
                  </li>
                </ul>
              </div>
            )}

            <form onSubmit={handleImport} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="supabase-url">Supabase Project URL</Label>
                <Input
                  id="supabase-url"
                  value={supabaseUrl}
                  onChange={(e) => {
                    setSupabaseUrl(e.target.value);
                    setValidated(false);
                    setImportNameManual(false);
                  }}
                  placeholder="https://xyzproject.supabase.co"
                  required
                  type="url"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="service-key">Service Role Key</Label>
                <PasswordInput
                  id="service-key"
                  value={serviceRoleKey}
                  onChange={(e) => {
                    setServiceRoleKey(e.target.value);
                    setValidated(false);
                    setImportNameManual(false);
                  }}
                  placeholder="eyJhbGciOiJIUzI1NiIs..."
                  required
                />
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Found in Supabase Dashboard &rarr; Settings &rarr; API &rarr; service_role key
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!supabaseUrl.trim() || !serviceRoleKey.trim() || validating}
                    onClick={handleValidateSupabase}
                    className="h-7 text-xs shrink-0"
                  >
                    {validating ? (
                      <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Checking...</>
                    ) : validated ? (
                      <><CheckCircle2 className="h-3 w-3 mr-1 text-emerald-500" />Connected</>
                    ) : (
                      'Validate'
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="db-password">Database password (optional)</Label>
                <PasswordInput
                  id="db-password"
                  value={databasePassword}
                  onChange={(e) => setDatabasePassword(e.target.value)}
                  placeholder="Only if some tables fail to import"
                />
                <p className="text-xs text-muted-foreground">
                  Normally the <strong>service_role</strong> key is enough. Use Dashboard &rarr; Database &rarr; password
                  only if specific tables still return permission errors — then we read those rows over a direct Postgres
                  connection.
                </p>
              </div>

              {validated && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 dark:bg-emerald-950/30 dark:border-emerald-800">
                  <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>Connection successful. Found <strong>{tableCount}</strong> tables.</span>
                  </div>
                </div>
              )}

              {!reimportTarget && (
                <div className="space-y-2">
                  <Label htmlFor="import-name">Project Name</Label>
                  <Input
                    id="import-name"
                    value={importName}
                    onChange={(e) => {
                      setImportName(e.target.value);
                      setImportNameManual(true);
                    }}
                    placeholder={validated ? 'Auto-filled from Supabase' : 'my-supabase-project'}
                    required
                    minLength={2}
                    maxLength={64}
                  />
                </div>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    reimportTarget ? handleOpenChange(false) : setView('create')
                  }
                >
                  {reimportTarget ? 'Cancel' : 'Back'}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !supabaseUrl.trim() ||
                    !serviceRoleKey.trim() ||
                    !(reimportTarget?.projectName ?? importName).trim()
                  }
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <SupabaseLogo className="h-4 w-4 mr-2 brightness-[10]" />
                  {reimportTarget ? 'Start re-import' : 'Start Import'}
                </Button>
              </DialogFooter>
            </form>

          </>
        )}

        {view === 'import-zip' && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    reimportTarget ? handleOpenChange(false) : setView('create')
                  }
                  className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  aria-label={reimportTarget ? 'Close' : 'Back'}
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="flex items-center gap-2">
                  <HardDrive className="h-5 w-5 text-blue-600" />
                  <DialogTitle>{reimportTarget ? 'Re-import from ZIP' : 'Import from ZIP'}</DialogTitle>
                </div>
              </div>
              <DialogDescription>
                {reimportTarget
                  ? (
                    <>
                      Upload an exported ZIP to overwrite{' '}
                      <span className="font-medium text-foreground">{reimportTarget.projectName}</span>.
                    </>
                  )
                  : 'Upload an exported ZIP and choose whether to create a duplicate project or overwrite an existing one.'}
              </DialogDescription>
            </DialogHeader>

            <form onSubmit={handleImportExportZip} className="space-y-3 rounded-lg border p-3">
              <div className="space-y-1">
                <Label htmlFor="zip-file">Import Exported ZIP</Label>
                <Input
                  id="zip-file"
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
                />
                <p className="text-xs text-muted-foreground">
                  Select a ZIP downloaded from the project export page.
                </p>
              </div>

              {!reimportTarget && (
              <div className="space-y-2">
                <p className="text-xs font-medium">Import target</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    className="h-4 w-4 accent-primary"
                    checked={zipImportMode === 'duplicate'}
                    onChange={() => setZipImportMode('duplicate')}
                  />
                  Create duplicate as a new project
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    className="h-4 w-4 accent-primary"
                    checked={zipImportMode === 'override'}
                    onChange={() => setZipImportMode('override')}
                  />
                  Override an existing project
                </label>
                {zipImportMode === 'override' && (
                  <select
                    value={zipExistingProjectId}
                    onChange={(e) => setZipExistingProjectId(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                    required
                  >
                    {teamProjects.length === 0 ? (
                      <option value="">No projects found in active team</option>
                    ) : (
                      teamProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))
                    )}
                  </select>
                )}
              </div>
              )}

              {!reimportTarget && zipImportMode === 'duplicate' && (
              <div className="space-y-2">
                <p className="text-xs font-medium">Project name confirmation</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    className="h-4 w-4 accent-primary"
                    checked={zipNameMode === 'existing'}
                    onChange={() => setZipNameMode('existing')}
                  />
                  Import with exported project name
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    className="h-4 w-4 accent-primary"
                    checked={zipNameMode === 'new'}
                    onChange={() => setZipNameMode('new')}
                  />
                  Import with a new project name
                </label>
                {zipNameMode === 'new' && (
                  <Input
                    value={zipNewName}
                    onChange={(e) => setZipNewName(e.target.value)}
                    placeholder="new-project-name"
                    minLength={2}
                    maxLength={64}
                    required
                  />
                )}
              </div>
              )}

              <Button type="submit" disabled={!zipFile || zipImporting} className="w-full">
                {zipImporting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Importing ZIP...
                  </>
                ) : (
                  reimportTarget ? 'Start re-import' : 'Import Export ZIP'
                )}
              </Button>
            </form>
          </>
        )}

        {view === 'importing' && (
          <>
            <DialogHeader className="pr-16">
              <div className="flex items-center gap-2">
                <SupabaseLogo className="h-5 w-5" />
                <DialogTitle>
                  {reimportTarget
                    ? 'Re-importing from Supabase'
                    : 'Importing from Supabase'}
                </DialogTitle>
              </div>
              <DialogDescription>
                {reimportTarget
                  ? 'Updating your existing basefyio project from Supabase. You can minimize this and continue working.'
                  : 'Please wait while your project is being imported. You can minimize this and continue working.'}
              </DialogDescription>
            </DialogHeader>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleOpenChange(false)}
              className="absolute top-3 right-4 h-7 w-7 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>

            <div className="space-y-3 py-4">
              {importSteps.map((step) => (
                <div key={step.key} className="flex items-start gap-3">
                  <div className="mt-0.5">
                    {step.status === 'active' && (
                      <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
                    )}
                    {step.status === 'done' && (
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    )}
                    {step.status === 'error' && (
                      <AlertTriangle className="h-5 w-5 text-red-500" />
                    )}
                    {step.status === 'pending' && (
                      <div className="h-5 w-5 rounded-full border-2 border-muted" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${
                      step.status === 'active' ? 'text-foreground' :
                      step.status === 'done' ? 'text-emerald-700 dark:text-emerald-400' :
                      step.status === 'error' ? 'text-red-600 dark:text-red-400' :
                      'text-muted-foreground'
                    }`}>
                      {step.label}
                    </p>
                    {step.detail && (
                      <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Progress bar */}
            <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-[width] duration-[800ms] ease-out"
                style={{ width: `${importPercent}%` }}
              />
            </div>

              <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 rounded-full bg-blue-50 px-3 py-2 text-xs text-blue-600 dark:bg-blue-950/30 dark:text-blue-400 min-w-0 flex-1 mr-2">
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                <span className="font-medium tabular-nums truncate transition-opacity duration-500 ease-out">
                  {importEta || importSteps.find((s) => s.status === 'active')?.detail || 'This may take a few minutes'}
                </span>
                {importStrategy && (
                  <span
                    key={importStrategy}
                    className="ml-auto shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 animate-in fade-in slide-in-from-right-1 duration-500"
                  >
                    {importStrategy}
                  </span>
                )}
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={cancelling}
                onClick={async () => {
                  if (
                    !confirm(
                      reimportJobRef.current
                        ? 'Cancel re-import? Your basefyio project will remain; partially imported data may be incomplete.'
                        : 'Cancel import? The project and all imported data will be deleted.',
                    )
                  )
                    return;
                  setCancelling(true);
                  try {
                    eventSourceRef.current?.close();
                    eventSourceRef.current = null;
                    await cancelImport();
                    toast.success('Import cancelled');
                    resetState();
                    onOpenChange(false);
                  } catch {
                    toast.error('Failed to cancel import');
                  } finally {
                    setCancelling(false);
                  }
                }}
                className="h-8 text-xs"
              >
                {cancelling ? 'Cancelling...' : 'Cancel Import'}
              </Button>
            </div>
          </>
        )}

        {view === 'result' && importResult && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                {importResultHasIssues ? (
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                )}
                <DialogTitle>
                  {importResultHasIssues
                    ? 'Import finished with issues'
                    : 'Import Complete'}
                </DialogTitle>
              </div>
              <DialogDescription>
                {importResultHasIssues ? (
                  <>
                    Project &ldquo;{importProjectName}&rdquo; was imported, but some
                    steps reported errors or warnings. Review the list below.
                  </>
                ) : (
                  <>
                    Project &ldquo;{importProjectName}&rdquo; has been imported
                    successfully.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              {importSteps.map((step) => (
                <div key={step.key} className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{step.label}</p>
                    {step.detail && (
                      <p className="text-xs text-muted-foreground mt-0.5">{step.detail}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {(() => {
              const w = importResult.warnings;
              const failed = importResult.database.failedTables;
              const skippedAuth = importResult.auth.skipped;
              const showPanel =
                w.length > 0 || failed.length > 0 || skippedAuth > 0;
              if (!showPanel) return null;
              const heading =
                w.length > 0
                  ? `Errors & warnings (${w.length})`
                  : 'Import issues (summary only)';
              return (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                  <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-400">
                    {heading}
                  </p>
                  {w.length === 0 && skippedAuth > 0 && (
                    <p className="mb-2 text-xs text-amber-700 dark:text-amber-500">
                      Auth: {skippedAuth} user(s) were not imported.
                    </p>
                  )}
                  {w.length === 0 && failed.length > 0 && (
                    <p className="mb-2 text-xs text-amber-700 dark:text-amber-500">
                      Database: {failed.length} table(s) could not be imported:{' '}
                      {failed.join(', ')}
                    </p>
                  )}
                  {w.length > 0 && (
                    <ul
                      className="max-h-48 space-y-1.5 overflow-y-auto pr-1 text-xs text-amber-900 dark:text-amber-400"
                      aria-label="Import issues"
                    >
                      {w.map((line, i) => (
                        <li
                          key={i}
                          className="flex gap-2 border-b border-amber-200/60 pb-1.5 last:border-0 dark:border-amber-800/50"
                        >
                          <span className="shrink-0 font-mono text-[10px] text-amber-600 dark:text-amber-500">
                            {i + 1}.
                          </span>
                          <span className="min-w-0 break-words">{line}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })()}

            <div className="flex items-center justify-center gap-2 flex-wrap">
              <Badge variant="secondary">
                <Database className="h-3 w-3 mr-1" />
                {importResult.database.tables} tables
              </Badge>
              <Badge variant="secondary">
                <Shield className="h-3 w-3 mr-1" />
                {importResult.auth.users} users
              </Badge>
              <Badge variant="secondary">
                <HardDrive className="h-3 w-3 mr-1" />
                {importResult.storage.objects} files
              </Badge>
            </div>

            <DialogFooter>
              <Button onClick={handleResultDone} className="w-full">
                Open project
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
