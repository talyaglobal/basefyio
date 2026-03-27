'use client';

import { useState, useRef, useEffect } from 'react';
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
import { ArrowLeft, Database, Shield, HardDrive, Loader2, CheckCircle2, AlertTriangle, Minus } from 'lucide-react';
import type { ImportProgressData, ImportJobProgressEvent } from '@/lib/types';

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  teamId: string;
}

type DialogView = 'create' | 'import' | 'importing' | 'result';

interface ImportStep {
  key: string;
  label: string;
  icon: React.ReactNode;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
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
}: CreateProjectDialogProps) {
  const [view, setView] = useState<DialogView>('create');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [serviceRoleKey, setServiceRoleKey] = useState('');
  const [importName, setImportName] = useState('');
  const [importNameManual, setImportNameManual] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(false);
  const [tableCount, setTableCount] = useState(0);
  const [importSteps, setImportSteps] = useState<ImportStep[]>([]);
  const [importPercent, setImportPercent] = useState(0);
  const [importResult, setImportResult] = useState<ImportProgressData | null>(null);
  const [importProjectName, setImportProjectName] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);
  const { activeImport, startTracking, cancelImport, setModalShowingImport, setOnReopenModal } = useImportProgress();
  const [cancelling, setCancelling] = useState(false);
  // Tracks if the dialog was dismissed while the import API call was still in-flight,
  // so the async continuation knows not to re-set modalShowingImport to true.
  const dismissedDuringImportRef = useRef(false);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  // Belt-and-suspenders: whenever the dialog closes with a running import,
  // ensure the toast becomes visible regardless of how the close happened.
  useEffect(() => {
    if (!open && activeImport?.status === 'running') {
      setModalShowingImport(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Register the reopen callback so the toast can reopen this dialog
  const activeImportRef = useRef(activeImport);
  activeImportRef.current = activeImport;

  useEffect(() => {
    const reopenFn = () => {
      const current = activeImportRef.current;
      if (current && current.status === 'running') {
        setView('importing');
        setImportProjectName(current.projectName);
        setImportPercent(current.percent);
        onOpenChange(true);
      }
    };

    setOnReopenModal(reopenFn);
    return () => setOnReopenModal(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpenChange, setOnReopenModal]);

  // Sync import steps from the global context when modal is reopened (no local SSE)
  useEffect(() => {
    if (view !== 'importing' || !activeImport) return;
    if (eventSourceRef.current) return; // local SSE is active, skip

    if (activeImport.status === 'completed' && activeImport.result) {
      setImportResult(activeImport.result);
      setView('result');
      return;
    }

    if (activeImport.status !== 'running') return;

    setImportPercent(activeImport.percent);

    const stepMap: Record<string, number> = { database: 1, auth: 2, storage: 3 };
    const currentStepIdx = stepMap[activeImport.step] ?? 0;

    setImportSteps([
      { key: 'connect', label: 'Connected to Supabase', icon: <Loader2 className="h-4 w-4" />, status: 'done' },
      { key: 'database', label: 'Importing Database', icon: <Database className="h-4 w-4" />, status: currentStepIdx > 1 ? 'done' : currentStepIdx === 1 ? 'active' : 'pending', detail: currentStepIdx === 1 ? activeImport.detail : undefined },
      { key: 'auth', label: 'Importing Auth Users', icon: <Shield className="h-4 w-4" />, status: currentStepIdx > 2 ? 'done' : currentStepIdx === 2 ? 'active' : 'pending', detail: currentStepIdx === 2 ? activeImport.detail : undefined },
      { key: 'storage', label: 'Importing Storage', icon: <HardDrive className="h-4 w-4" />, status: currentStepIdx === 3 ? 'active' : 'pending', detail: currentStepIdx === 3 ? activeImport.detail : undefined },
    ]);
  }, [view, activeImport?.step, activeImport?.percent, activeImport?.detail, activeImport?.status]);

  function resetState() {
    setView('create');
    setName('');
    setDescription('');
    setSupabaseUrl('');
    setServiceRoleKey('');
    setImportName('');
    setImportNameManual(false);
    setValidating(false);
    setValidated(false);
    setTableCount(0);
    setImportSteps([]);
    setImportPercent(0);
    setImportResult(null);
    setImportProjectName('');
    setLoading(false);
    setCancelling(false);
    dismissedDuringImportRef.current = false;
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
        setView('create');
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
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  function updateStepFromSSE(data: ImportJobProgressEvent) {
    setImportPercent(data.percent || 0);

    setImportSteps((prev) => {
      const steps = [...prev];
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
    setView('importing');

    const steps: ImportStep[] = [
      { key: 'connect', label: 'Connecting to Supabase', icon: <Loader2 className="h-4 w-4" />, status: 'active' },
      { key: 'database', label: 'Importing Database', icon: <Database className="h-4 w-4" />, status: 'pending' },
      { key: 'auth', label: 'Importing Auth Users', icon: <Shield className="h-4 w-4" />, status: 'pending' },
      { key: 'storage', label: 'Importing Storage', icon: <HardDrive className="h-4 w-4" />, status: 'pending' },
    ];
    setImportSteps(steps);

    try {
      const result = await api.projects.importFromSupabase({
        supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
        serviceRoleKey,
        name: importName,
        teamId,
      });

      setImportProjectName(result.project.name);

      // Always start global tracking so the job is persisted and the context SSE runs.
      startTracking(result.jobId, result.project.name, onCreated);

      // Only mark the modal as "showing import" if the dialog wasn't dismissed
      // while the API call was in-flight (race condition guard).
      if (!dismissedDuringImportRef.current) {
        setModalShowingImport(true);
      }

      // Local SSE is only needed while the modal is open.
      if (dismissedDuringImportRef.current) return;

      const es = api.projects.streamImportProgress(result.jobId, {
        onProgress: (data) => {
          updateStepFromSSE(data);
        },
        onCompleted: (data) => {
          const progress: ImportProgressData = data.progress;

          setImportSteps((prev) => {
            const s = [...prev];
            s[0] = { ...s[0], status: 'done', label: 'Connected to Supabase' };
            s[1] = { ...s[1], status: 'done', detail: `${progress.database.tables} tables, ${progress.database.rows} rows` };
            s[2] = { ...s[2], status: 'done', detail: `${progress.auth.users} users` };
            s[3] = { ...s[3], status: 'done', detail: `${progress.storage.buckets} buckets, ${progress.storage.objects} objects` };
            return s;
          });
          setImportPercent(100);
          setImportResult(progress);
          setView('result');
          toast.success(`Project "${result.project.name}" imported from Supabase`);
          onCreated();
        },
        onFailed: (error) => {
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
      setImportSteps((prev) => {
        const s = [...prev];
        s[0] = { ...s[0], status: 'error', detail: err.message };
        return s;
      });
      toast.error(`Import failed: ${err.message}`);
      setView('import');
    }
  }

  function handleResultDone() {
    setModalShowingImport(false);
    resetState();
    onCreated();
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
          </>
        )}

        {view === 'import' && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setView('create')}
                  className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <div className="flex items-center gap-2">
                  <SupabaseLogo className="h-5 w-5" />
                  <DialogTitle>Import from Supabase</DialogTitle>
                </div>
              </div>
              <DialogDescription>
                Clone a Supabase project including database, auth users, and
                storage files.
              </DialogDescription>
            </DialogHeader>

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

              {validated && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 dark:bg-emerald-950/30 dark:border-emerald-800">
                  <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>Connection successful. Found <strong>{tableCount}</strong> tables.</span>
                  </div>
                </div>
              )}

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

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setView('create')}
                >
                  Back
                </Button>
                <Button
                  type="submit"
                  disabled={!supabaseUrl.trim() || !serviceRoleKey.trim() || !importName.trim()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <SupabaseLogo className="h-4 w-4 mr-2 brightness-[10]" />
                  Start Import
                </Button>
              </DialogFooter>
            </form>
          </>
        )}

        {view === 'importing' && (
          <>
            <DialogHeader className="pr-16">
              <div className="flex items-center gap-2">
                <SupabaseLogo className="h-5 w-5" />
                <DialogTitle>Importing from Supabase</DialogTitle>
              </div>
              <DialogDescription>
                Please wait while your project is being imported.
                You can minimize this and continue working.
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
                className="h-full bg-emerald-500 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${importPercent}%` }}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 rounded-full bg-blue-50 px-3 py-2 text-xs text-blue-600 dark:bg-blue-950/30 dark:text-blue-400 min-w-0 max-w-[260px]">
                <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                <span className="truncate">
                  {importSteps.find((s) => s.status === 'active')?.detail || 'This may take a few minutes'}
                </span>
              </div>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={cancelling}
                onClick={async () => {
                  if (!confirm('Cancel import? The project and all imported data will be deleted.')) return;
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
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                <DialogTitle>Import Complete</DialogTitle>
              </div>
              <DialogDescription>
                Project &ldquo;{importProjectName}&rdquo; has been imported
                successfully.
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

            {importResult.warnings.length > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 dark:bg-amber-950/30 dark:border-amber-800">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">Warnings</p>
                <ul className="space-y-1">
                  {importResult.warnings.map((w, i) => (
                    <li key={i} className="text-xs text-amber-600 dark:text-amber-500 flex gap-1.5">
                      <span className="shrink-0">&#x2022;</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

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
                Go to Projects
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
