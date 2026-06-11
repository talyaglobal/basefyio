'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import Cookies from 'js-cookie';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Project } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ProjectProvider } from '@/contexts/project-context';
import { ContextHelpPanel } from '@/components/context-help-panel';
import { subscribebasefyioRealtime, isRealtimePhase1Enabled } from '@/lib/basefyio-realtime';
import type { RealtimeEventEnvelope } from '@/lib/realtime-types';
import { parseJwt, getAccessToken } from '@/lib/auth';
import {
  Book,
  BrainCircuit,
  Copy,
  Database,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Key,
  Link2,
  Plug,
  Settings,
  Shield,
  ScrollText,
  Table2,
  Terminal,
} from 'lucide-react';

const SIDEBAR_MODE_KEY = 'basefyio_project_sidebar_mode';
const SIDEBAR_WIDTH_KEY = 'basefyio_project_sidebar_width';
const SIDEBAR_COLLAPSED_PX = 52;
const SIDEBAR_MIN_PX = 200;
const SIDEBAR_MAX_PX = 440;

type SidebarMode = 'auto' | 'open';

function readStoredMode(): SidebarMode {
  if (typeof window === 'undefined') return 'open';
  const m = localStorage.getItem(SIDEBAR_MODE_KEY);
  return m === 'auto' || m === 'open' ? m : 'open';
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return 224;
  const w = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  const n = w ? parseInt(w, 10) : 224;
  if (!Number.isFinite(n)) return 224;
  return Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, n));
}

/** iOS-style segmented control for sidebar Auto / Open */
function SidebarModeIosSegmented({
  mode,
  onModeChange,
  layout,
}: {
  mode: SidebarMode;
  onModeChange: (m: SidebarMode) => void;
  layout: 'horizontal' | 'vertical';
}) {
  const segment = (m: SidebarMode, label: string) => (
    <button
      key={m}
      type="button"
      role="radio"
      aria-checked={mode === m}
      title={
        m === 'auto'
          ? 'Auto — narrow rail; expands on hover'
          : 'Open — sidebar stays expanded; drag right edge to resize'
      }
      onClick={() => onModeChange(m)}
      className={cn(
        'font-semibold transition-all duration-200 ease-out',
        layout === 'horizontal'
          ? 'flex-1 rounded-[7px] py-1.5 text-[13px] leading-none'
          : 'w-full rounded-[6px] py-1.5 text-[10px] leading-tight',
        mode === m
          ? 'bg-background text-foreground shadow-sm dark:bg-background/95 dark:shadow-black/20'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <div
      className={cn(
        'rounded-[10px] bg-muted/90 p-[3px] shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] dark:bg-muted/50 dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]',
        layout === 'horizontal' ? 'flex w-full flex-row gap-[3px]' : 'flex w-full flex-col gap-[3px]',
      )}
      role="radiogroup"
      aria-label="Sidebar mode"
    >
      {segment('auto', 'Auto')}
      {segment('open', 'Open')}
    </div>
  );
}

const navItems = [
  { label: 'Overview', href: '', icon: Database },
  // Tables, collections, and Data Engine entities live in one unified editor.
  { label: 'Data', href: '/tables', icon: Table2 },
  { label: 'SQL Editor', href: '/sql', icon: Terminal },
  { label: 'Storage', href: '/storage', icon: FolderOpen },
  { label: 'Auth', href: '/auth', icon: Shield },
  { label: 'REST API', href: '/api-explorer', icon: Globe },
  { label: 'Connection', href: '/connect', icon: Link2 },
  { label: 'Backup & Export', href: '/backup', icon: Download },
  { label: 'Integrations', href: '/integrations', icon: Plug },
  { label: 'AI / Embeddings', href: '/embeddings', icon: BrainCircuit },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export default function ProjectLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [projectLoading, setProjectLoading] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readStoredMode);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth);
  const [autoExpanded, setAutoExpanded] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const autoLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recoverProjectWithTeamSwitch = useCallback(
    async (projectId: string): Promise<Project | null> => {
      try {
        const teams = await api.teams.list();
        for (const team of teams) {
          try {
            await api.teams.setActive(team.id);
            Cookies.set('basefyio_active_team', team.id, { expires: 365, path: '/' });
            const loaded = await api.projects.get(projectId);
            return loaded;
          } catch {
            // Try next team.
          }
        }
      } catch {
        // teams.list() failed
      }
      return null;
    },
    [],
  );

  useEffect(() => {
    localStorage.setItem(SIDEBAR_MODE_KEY, sidebarMode);
  }, [sidebarMode]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const clearAutoLeaveTimer = useCallback(() => {
    if (autoLeaveTimer.current) {
      clearTimeout(autoLeaveTimer.current);
      autoLeaveTimer.current = null;
    }
  }, []);

  const handleAsideEnter = useCallback(() => {
    if (sidebarMode !== 'auto') return;
    clearAutoLeaveTimer();
    setAutoExpanded(true);
  }, [sidebarMode, clearAutoLeaveTimer]);

  const handleAsideLeave = useCallback(() => {
    if (sidebarMode !== 'auto') return;
    clearAutoLeaveTimer();
    autoLeaveTimer.current = setTimeout(() => {
      setAutoExpanded(false);
      autoLeaveTimer.current = null;
    }, 220);
  }, [sidebarMode, clearAutoLeaveTimer]);

  useEffect(() => () => clearAutoLeaveTimer(), [clearAutoLeaveTimer]);

  const sidebarExpanded =
    sidebarMode === 'open' || (sidebarMode === 'auto' && autoExpanded);
  const asideWidthPx = sidebarExpanded ? sidebarWidth : SIDEBAR_COLLAPSED_PX;

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!sidebarExpanded) return;
      setIsResizing(true);
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        const next = Math.min(
          SIDEBAR_MAX_PX,
          Math.max(SIDEBAR_MIN_PX, startW + ev.clientX - startX),
        );
        setSidebarWidth(next);
      };
      const onUp = () => {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [sidebarExpanded, sidebarWidth],
  );

  const refreshProject = useCallback(async () => {
    if (!id) return;
    try {
      const proj = await api.projects.get(id);
      setProject(proj);
    } catch {
      toast.error('Failed to refresh project');
    }
  }, [id]);

  // Realtime: subscribe to project channel for live updates
  useEffect(() => {
    if (!id || projectLoading || !project) return;
    if (!isRealtimePhase1Enabled()) return;
    const currentUserId = parseJwt(getAccessToken() ?? '')?.sub ?? '';
    const unsubscribe = subscribebasefyioRealtime(`project:${id}`, (event: RealtimeEventEnvelope) => {
      if (event.entityType !== 'project') return;
      // Skip self-triggered updates (UI already reflects the change)
      if (event.action === 'updated' && event.actorUserId === currentUserId) return;
      if (event.action === 'deleted') {
        toast.error('This project has been deleted');
        router.push('/dashboard/projects');
        return;
      }
      refreshProject();
    });
    return () => { unsubscribe?.(); };
  }, [id, projectLoading, project, refreshProject, router]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setProjectLoading(true);

    (async () => {
      try {
        const proj = await api.projects.get(id);
        if (!cancelled) setProject(proj);
      } catch (err) {
        console.error('[ProjectLayout] Failed to load project:', id, err);
        try {
          const recovered = await recoverProjectWithTeamSwitch(id);
          if (!cancelled && recovered) {
            setProject(recovered);
            return;
          }
        } catch (recErr) {
          console.error('[ProjectLayout] Recovery also failed:', recErr);
        }
        if (!cancelled) {
          toast.error('Failed to load project');
          router.push('/dashboard/projects');
        }
      } finally {
        if (!cancelled) setProjectLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [id, router, recoverProjectWithTeamSwitch]);

  if (projectLoading) {
    return (
      <ProjectProvider project={null} loading={true}>
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </ProjectProvider>
    );
  }

  if (!project) {
    return (
      <ProjectProvider project={null} loading={false}>
        <div className="flex h-64 items-center justify-center">
          <p className="text-muted-foreground">Project not found.</p>
        </div>
      </ProjectProvider>
    );
  }

  const basePath = `/dashboard/projects/${id}`;
  const isLogsRoute = pathname.startsWith(`${basePath}/logs`);
  const isFullHeightRoute = pathname.startsWith(`${basePath}/tables`) || pathname.startsWith(`${basePath}/sql`);

  return (
    <ProjectProvider project={project} loading={false} refreshProject={refreshProject}>
      <div
      className={cn(
        'absolute inset-0 flex min-w-0 overflow-hidden',
        isResizing && 'select-none',
      )}
    >
      <aside
        className={cn(
          'h-full shrink-0',
          'border-r bg-card flex flex-col overflow-hidden',
          'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        )}
        style={{ width: asideWidthPx }}
        onMouseEnter={handleAsideEnter}
        onMouseLeave={handleAsideLeave}
      >
        {sidebarExpanded ? (
          <>
            <div className="border-b p-4">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Database className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{project.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{project.slug}</p>
                </div>
              </div>
            </div>

            <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
              {navItems.map((item) => {
                const href = `${basePath}${item.href}`;
                const active =
                  item.href === ''
                    ? pathname === basePath
                    : pathname.startsWith(href);

                return (
                  <Link
                    key={item.label}
                    href={href}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mx-2 mt-2 rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Key className="h-3 w-3 shrink-0" />
                  API Keys
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  title="Copy anon key"
                  aria-label="Copy anon key"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(project.anonKey);
                      toast.success('Anon key copied');
                    } catch {
                      toast.error('Could not copy to clipboard');
                    }
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p
                className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground"
                title={project.anonKey}
              >
                anon: {project.anonKey}
              </p>
            </div>

            <div className="mx-2 mt-2 space-y-0.5">
              <Link
                href={`${basePath}/logs`}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  pathname.startsWith(`${basePath}/logs`)
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <ScrollText className="h-4 w-4 shrink-0" />
                Project logs
              </Link>
              <a
                href={`${process.env.NEXT_PUBLIC_DOCS_URL || 'https://basefyio.com'}/docs`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Book className="h-4 w-4 shrink-0" />
                Documentation
                <ExternalLink className="ml-auto h-3 w-3 opacity-50" />
              </a>
            </div>

            <div className="mx-2 mt-3 mb-2 flex items-center gap-2.5">
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                Sidebar
              </span>
              <div className="min-w-0 flex-1">
                <SidebarModeIosSegmented
                  mode={sidebarMode}
                  layout="horizontal"
                  onModeChange={(m) => {
                    setSidebarMode(m);
                    if (m === 'auto') setAutoExpanded(false);
                  }}
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col items-center gap-2 border-b py-3">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10"
                title={project.name}
              >
                <Database className="h-4 w-4 text-primary" />
              </div>
            </div>
            <nav className="flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto py-2">
              {navItems.map((item) => {
                const href = `${basePath}${item.href}`;
                const active =
                  item.href === ''
                    ? pathname === basePath
                    : pathname.startsWith(href);

                return (
                  <Link
                    key={item.label}
                    href={href}
                    title={item.label}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                  </Link>
                );
              })}
            </nav>
            <div className="mt-auto flex w-full flex-col items-center gap-2 border-t px-1.5 py-2">
              <Link
                href={`${basePath}/logs`}
                title="Project logs"
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                  pathname.startsWith(`${basePath}/logs`)
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <ScrollText className="h-4 w-4" />
              </Link>
              <a
                href={`${process.env.NEXT_PUBLIC_DOCS_URL || 'https://basefyio.com'}/docs`}
                target="_blank"
                rel="noopener noreferrer"
                title="Documentation"
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <Book className="h-4 w-4" />
              </a>
              <span
                className="text-center text-[10px] font-medium leading-tight text-muted-foreground"
                title="Sidebar auto — hover to expand"
              >
                Auto
              </span>
            </div>
          </>
        )}

        {/* Resize handle (chat-style) — only when expanded */}
        {sidebarExpanded && (
          <button
            type="button"
            aria-label="Resize sidebar"
            onMouseDown={startResize}
            className={cn(
              'absolute right-0 top-0 z-20 h-full w-2 -translate-x-1/2 cursor-col-resize border-0 bg-transparent p-0',
              'hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            )}
          />
        )}
      </aside>

      <div className="h-full min-h-0 min-w-0 flex-1 flex relative">
        <main
          className={cn(
            'h-full min-h-0 min-w-0 flex-1 p-6',
            (isLogsRoute || isFullHeightRoute) ? 'flex flex-col overflow-hidden' : 'overflow-y-auto',
          )}
        >
          {children}
        </main>
        <ContextHelpPanel />
      </div>
    </div>
    </ProjectProvider>
  );
}
