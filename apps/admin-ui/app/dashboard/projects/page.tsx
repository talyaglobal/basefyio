'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  DndContext,
  DragCancelEvent,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  pointerWithin,
  rectIntersection,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { KeyboardSensor } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { api } from '@/lib/api';
import type { ProjectListItem, ProjectFolder, ProjectTag } from '@/lib/types';
import { startOfMonth, parseISO, isWithinInterval } from 'date-fns';
import { useActiveTeam } from '../layout';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ArrowLeft,
  ArrowRightLeft,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SortAsc,
  Tag,
  Trash2,
  X,
  Zap,
  LayoutGrid,
  List,
} from 'lucide-react';
import type { Team } from '@/lib/types';
import { subscribeKbRealtime, isRealtimePhase1Enabled } from '@/lib/supabase-realtime';
import type { RealtimeEventEnvelope } from '@/lib/realtime-types';

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'status-active',
  PAUSED: 'status-paused',
  DELETED: 'status-deleted',
};
const STATUS_DOT: Record<string, string> = {
  ACTIVE: 'bg-emerald-500',
  PAUSED: 'bg-amber-500',
  DELETED: 'bg-red-500',
};
const COLORS = [
  '#1d4ed8', '#2563eb', '#0ea5e9', '#06b6d4', '#10b981',
  '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#6366f1',
];
const DND_PROJECT = 'project';
const DND_TAG     = 'tag';
const DND_FOLDER  = 'folder';
const DND_TRASH   = 'trash';

/** Matches All Projects / folder / tag row highlight while dragging a project (sortable+droppable id mismatch fix). */
const SIDEBAR_DROP_ROW =
  'bg-primary/10 text-primary font-medium ring-2 ring-primary/50';

// Custom collision: pointer-within first (precise), fall back to rect-intersection (handles large cards)
function customCollision(args: Parameters<typeof pointerWithin>[0]) {
  const hits = pointerWithin(args);
  if (hits.length > 0) return hits;
  return rectIntersection(args);
}

const SORT_OPTIONS = [
  { value: 'newest',    label: 'Newest' },
  { value: 'oldest',    label: 'Oldest' },
  { value: 'name-asc',  label: 'Name (A-Z)' },
  { value: 'name-desc', label: 'Name (Z-A)' },
] as const;
type SortValue = typeof SORT_OPTIONS[number]['value'];

const DELETE_REASONS = [
  { code: 'performance', label: 'Performance or reliability insufficient.' },
  { code: 'trust', label: 'I lost trust in the company or its future direction.' },
  { code: 'exploring', label: 'I was just exploring, or it was a hobby/student project.' },
  { code: 'cancelled', label: 'My project was cancelled or put on hold.' },
  { code: 'support', label: 'I was not satisfied with the customer support I received.' },
  { code: 'pricing_unpredictable', label: 'The pricing is unpredictable and hard to budget for.' },
  { code: 'too_expensive', label: 'Too expensive' },
  { code: 'missing_feature', label: 'Kolaybase is missing a specific feature I need.' },
  { code: 'company_closed', label: 'My company went out of business or was acquired.' },
  { code: 'difficult', label: 'I found it difficult to use or build with.' },
  { code: 'none', label: 'None of the above' },
] as const;

// ── Session state key ─────────────────────────────────────────────────────────
const SESSION_KEY = 'kb_projects_state';

interface ProjectsState {
  selectedFolder: string;
  selectedTags: string[];
  searchQuery: string;
  statusFilter: string | null;
  thisMonthOnly: boolean;
  sortBy: SortValue;
}

type ProjectsViewMode = 'grid' | 'list';
const PROJECTS_VIEW_MODE_KEY = 'kb_projects_view_mode';

function formatDateTime(value: string) {
  const date = new Date(value);
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSize(bytes?: number | null) {
  if (!bytes || bytes < 0) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function saveProjectsState(state: ProjectsState) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); } catch {}
}

function loadProjectsState(): ProjectsState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as ProjectsState) : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ProjectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeTeamId } = useActiveTeam();

  const [projects, setProjects]     = useState<ProjectListItem[]>([]);
  const [folders, setFolders]       = useState<ProjectFolder[]>([]);
  const [tags, setTags]             = useState<ProjectTag[]>([]);
  const [loading, setLoading]       = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  // URL params take precedence over saved state (dashboard card clicks always win)
  const urlStatus = searchParams.get('status');
  const urlFilter = searchParams.get('filter');
  const hasUrlParams = !!(urlStatus || urlFilter);

  // Restore from sessionStorage on first mount (unless URL params override)
  // When URL params are present (coming from dashboard), clear saved state so it doesn't bleed
  const savedState = (() => {
    if (hasUrlParams) {
      try { sessionStorage.removeItem(SESSION_KEY); } catch {}
      return null;
    }
    return loadProjectsState();
  })();

  const [selectedFolder, setSelectedFolder] = useState<string | 'all'>(savedState?.selectedFolder ?? 'all');
  const [selectedTags, setSelectedTags]     = useState<string[]>(savedState?.selectedTags ?? []);
  const [searchQuery, setSearchQuery]       = useState(savedState?.searchQuery ?? '');
  const [statusFilter, setStatusFilter]     = useState<string | null>(urlStatus ?? savedState?.statusFilter ?? null);
  const [thisMonthOnly, setThisMonthOnly]   = useState(urlFilter === 'this-month' ? true : (savedState?.thisMonthOnly ?? false));
  const [sortBy, setSortBy]                 = useState<SortValue>(savedState?.sortBy ?? 'newest');
  const [sortOpen, setSortOpen]             = useState(false);
  const [viewMode, setViewMode]             = useState<ProjectsViewMode>(() => {
    if (typeof window === 'undefined') return 'grid';
    const stored = localStorage.getItem(PROJECTS_VIEW_MODE_KEY);
    return stored === 'list' ? 'list' : 'grid';
  });

  // Multi-select
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());

  // Folder modal
  const [folderModal, setFolderModal] = useState<{ open: boolean; editing?: ProjectFolder }>({ open: false });
  const [folderName, setFolderName]   = useState('');
  const [folderColor, setFolderColor] = useState(COLORS[0]);

  // Tag modal (create or edit)
  const [tagModal, setTagModal] = useState<{ open: boolean; editing?: ProjectTag }>({ open: false });
  const [tagName, setTagName]   = useState('');
  const [tagColor, setTagColor] = useState(COLORS[1]);

  // Sidebar right-click context menu (folder or tag)
  const [sidebarCtx, setSidebarCtx] = useState<{
    type: 'folder' | 'tag';
    item: ProjectFolder | ProjectTag;
    x: number;
    y: number;
  } | null>(null);
  const sidebarCtxRef = useRef<HTMLDivElement>(null);

  // DnD overlay
  const [activeProject, setActiveProject] = useState<ProjectListItem | null>(null);
  const [activeTag, setActiveTag]         = useState<ProjectTag | null>(null);
  const [activeFolder, setActiveFolder]   = useState<ProjectFolder | null>(null);
  /** `over.id` while dragging — folder/tag rows use sortable id; droppable id differs, so hooks miss `isOver`. */
  const [dropTargetId, setDropTargetId]   = useState<string | null>(null);

  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number; project: ProjectListItem;
    sub: null | 'folder' | 'tag' | 'team';
  } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  // Edit project modal
  const [editModal, setEditModal] = useState<{ open: boolean; project: ProjectListItem | null }>({ open: false, project: null });
  const [editName, setEditName]   = useState('');
  const [editDesc, setEditDesc]   = useState('');
  const [editSaving, setEditSaving] = useState(false);

  // Single-project delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState<ProjectListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk delete confirm
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteReasonCode, setBulkDeleteReasonCode] = useState<string>('none');
  const [bulkDeleteDetails, setBulkDeleteDetails] = useState('');
  const [bulkDeleteConfirmText, setBulkDeleteConfirmText] = useState('');

  // Move to team
  const [teams, setTeams] = useState<Team[]>([]);
  const [moveTeamModal, setMoveTeamModal] = useState<{ project: ProjectListItem; targetTeam: Team } | null>(null);
  const [movingTeam, setMovingTeam] = useState(false);

  // Deleted projects (trash)
  const [showTrash, setShowTrash] = useState(false);
  const [deletedProjects, setDeletedProjects] = useState<ProjectListItem[]>([]);
  const [loadingTrash, setLoadingTrash] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [permDeleteConfirm, setPermDeleteConfirm] = useState<ProjectListItem | null>(null);
  const [permDeleting, setPermDeleting] = useState(false);

  // Sort dropdown ref
  const sortRef = useRef<HTMLDivElement>(null);

  const [isOwner, setIsOwner] = useState(false);

  // ── DnD sensors ──────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ── Load ─────────────────────────────────────────────────────────────────────
  const loadAll = useCallback(async () => {
    if (!activeTeamId) return;
    setLoading(true);
    try {
      const [p, f, t, allTeams] = await Promise.all([
        api.projects.list(activeTeamId),
        api.folders.list(activeTeamId),
        api.tags.list(activeTeamId),
        api.teams.list(),
      ]);
      setProjects(p);
      setFolders(f);
      setTags(t);
      setTeams(allTeams);
      setIsOwner(allTeams.some((tm) => tm.id === activeTeamId && tm.role === 'OWNER'));
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeTeamId]);

  useEffect(() => { loadAll(); setShowTrash(false); setDeletedProjects([]); setIsOwner(false); }, [loadAll]);

  useEffect(() => {
    if (!activeTeamId) return;
    if (!isRealtimePhase1Enabled()) return;
    const unsubscribe = subscribeKbRealtime(`team:${activeTeamId}`, (event: RealtimeEventEnvelope) => {
      if (event.teamId !== activeTeamId) return;
      if (event.entityType === 'project' || event.entityType === 'project_activity' || event.entityType === 'team') {
        void loadAll();
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [activeTeamId, loadAll]);

  // Close context menus + sort dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null);
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
      if (sidebarCtxRef.current && !sidebarCtxRef.current.contains(e.target as Node)) setSidebarCtx(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    localStorage.setItem(PROJECTS_VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  // ── Tag project counts ────────────────────────────────────────────────────────
  const tagProjectCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of projects) {
      for (const { tag } of (p.tags ?? [])) {
        counts[tag.id] = (counts[tag.id] ?? 0) + 1;
      }
    }
    return counts;
  }, [projects]);

  // ── Filtered + sorted projects ────────────────────────────────────────────────
  const monthStart = startOfMonth(new Date());

  const filtered = projects
    .filter((p) => {
      if (selectedFolder !== 'all' && p.folderId !== selectedFolder) return false;
      if (selectedTags.length > 0) {
        const pTagIds = (p.tags ?? []).map((t) => t.tag.id);
        if (!selectedTags.every((tid) => pTagIds.includes(tid))) return false;
      }
      if (statusFilter && p.status !== statusFilter) return false;
      if (thisMonthOnly) {
        if (!isWithinInterval(parseISO(p.createdAt), { start: monthStart, end: new Date() })) return false;
      }
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !(p.description ?? '').toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'name-asc')  return a.name.localeCompare(b.name);
      if (sortBy === 'name-desc') return b.name.localeCompare(a.name);
      if (sortBy === 'oldest')    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  // ── Navigate to project (saves state first) ──────────────────────────────────
  function openProject(projectId: string) {
    saveProjectsState({ selectedFolder, selectedTags, searchQuery, statusFilter, thisMonthOnly, sortBy });
    router.push(`/dashboard/projects/${projectId}`);
  }

  // ── Folder CRUD ───────────────────────────────────────────────────────────────
  async function saveFolder() {
    if (!activeTeamId || !folderName.trim()) return;
    try {
      if (folderModal.editing) {
        const updated = await api.folders.update(folderModal.editing.id, { name: folderName, color: folderColor });
        setFolders((prev) => prev.map((f) => (f.id === updated.id ? updated : f)));
        toast.success('Folder updated');
      } else {
        const created = await api.folders.create(activeTeamId, folderName.trim(), folderColor);
        setFolders((prev) => [...prev, created]);
        toast.success('Folder created');
      }
      setFolderModal({ open: false });
      setFolderName('');
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function deleteFolder(id: string) {
    try {
      await api.folders.delete(id);
      setFolders((prev) => prev.filter((f) => f.id !== id));
      if (selectedFolder === id) setSelectedFolder('all');
      toast.success('Folder deleted');
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // ── Tag CRUD ──────────────────────────────────────────────────────────────────
  async function saveTag() {
    if (!tagName.trim()) return;
    try {
      if (tagModal.editing) {
        const updated = await api.tags.update(tagModal.editing.id, { name: tagName, color: tagColor });
        setTags((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
        toast.success('Tag updated');
      } else {
        if (!activeTeamId) return;
        const created = await api.tags.create(activeTeamId, tagName.trim(), tagColor);
        setTags((prev) => [...prev, created]);
        toast.success('Tag created');
      }
      setTagModal({ open: false });
      setTagName('');
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function deleteTag(id: string) {
    try {
      await api.tags.delete(id);
      setTags((prev) => prev.filter((t) => t.id !== id));
      setSelectedTags((prev) => prev.filter((t) => t !== id));
      toast.success('Tag deleted');
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function quickCreateFolder(): Promise<ProjectFolder | null> {
    if (!activeTeamId) return null;
    const name = window.prompt('New folder name');
    if (!name || !name.trim()) return null;
    try {
      const created = await api.folders.create(activeTeamId, name.trim(), COLORS[0]);
      setFolders((prev) => [...prev, created]);
      toast.success('Folder created');
      return created;
    } catch (err: any) {
      toast.error(err.message || 'Failed to create folder');
      return null;
    }
  }

  async function quickCreateTag(): Promise<ProjectTag | null> {
    if (!activeTeamId) return null;
    const name = window.prompt('New tag name');
    if (!name || !name.trim()) return null;
    try {
      const created = await api.tags.create(activeTeamId, name.trim(), COLORS[1]);
      setTags((prev) => [...prev, created]);
      toast.success('Tag created');
      return created;
    } catch (err: any) {
      toast.error(err.message || 'Failed to create tag');
      return null;
    }
  }

  // ── Project updates ───────────────────────────────────────────────────────────
  async function moveToFolder(projectId: string, folderId: string | null) {
    try {
      const updated = await api.projects.update(projectId, { folderId });
      setProjects((prev) => prev.map((p) => (p.id === updated!.id ? { ...p, ...(updated as ProjectListItem) } : p)));
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function toggleTag(projectId: string, tagId: string) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const currentTagIds = (project.tags ?? []).map((t) => t.tag.id);
    const newTagIds = currentTagIds.includes(tagId)
      ? currentTagIds.filter((id) => id !== tagId)
      : [...currentTagIds, tagId];
    try {
      const updated = await api.projects.update(projectId, { tags: newTagIds });
      setProjects((prev) => prev.map((p) => (p.id === updated!.id ? { ...p, ...(updated as ProjectListItem) } : p)));
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  // ── Edit project ─────────────────────────────────────────────────────────────
  function openEditModal(project: ProjectListItem) {
    setEditName(project.name);
    setEditDesc((project as any).description ?? '');
    setEditModal({ open: true, project });
  }

  async function saveEditProject() {
    if (!editModal.project || !editName.trim()) return;
    setEditSaving(true);
    try {
      const updated = await api.projects.update(editModal.project.id, {
        name: editName.trim(),
        description: editDesc.trim() || undefined,
      });
      setProjects((prev) => prev.map((p) => (p.id === editModal.project!.id ? { ...p, ...(updated as ProjectListItem), name: editName.trim() } : p)));
      toast.success('Project updated');
      setEditModal({ open: false, project: null });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setEditSaving(false);
    }
  }

  // ── Delete project (single) ───────────────────────────────────────────────────
  async function confirmDeleteProject() {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await api.projects.delete(deleteConfirm.id);
      setProjects((prev) => prev.filter((p) => p.id !== deleteConfirm.id));
      setSelectedProjects((prev) => { const n = new Set(prev); n.delete(deleteConfirm.id); return n; });
      toast.success(`"${deleteConfirm.name}" moved to trash`);
      setDeleteConfirm(null);
      if (isOwner && activeTeamId) loadDeletedProjects();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleMoveToTeam() {
    if (!moveTeamModal) return;
    setMovingTeam(true);
    try {
      await api.projects.moveToTeam(moveTeamModal.project.id, moveTeamModal.targetTeam.id);
      setProjects((prev) => prev.filter((p) => p.id !== moveTeamModal.project.id));
      setSelectedProjects((prev) => { const n = new Set(prev); n.delete(moveTeamModal.project.id); return n; });
      toast.success(`"${moveTeamModal.project.name}" moved to "${moveTeamModal.targetTeam.name}"`);
      setMoveTeamModal(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to move project');
    } finally {
      setMovingTeam(false);
    }
  }

  // ── Trash (deleted projects) ──────────────────────────────────────────────────
  async function loadDeletedProjects() {
    if (!activeTeamId) return;
    setLoadingTrash(true);
    try {
      const deleted = await api.projects.listDeleted(activeTeamId);
      setDeletedProjects(deleted);
    } catch {
      setDeletedProjects([]);
    } finally {
      setLoadingTrash(false);
    }
  }

  async function handleRestore(id: string) {
    setRestoringId(id);
    try {
      await api.projects.restore(id);
      setDeletedProjects((prev) => prev.filter((p) => p.id !== id));
      toast.success('Project restored');
      loadAll();
    } catch (err: any) {
      toast.error(err.message || 'Failed to restore project');
    } finally {
      setRestoringId(null);
    }
  }

  async function handlePermanentDelete() {
    if (!permDeleteConfirm) return;
    setPermDeleting(true);
    try {
      await api.projects.permanentDelete(permDeleteConfirm.id);
      setDeletedProjects((prev) => prev.filter((p) => p.id !== permDeleteConfirm.id));
      toast.success('Project permanently deleted');
      setPermDeleteConfirm(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete project');
    } finally {
      setPermDeleting(false);
    }
  }

  useEffect(() => {
    if (showTrash || isOwner) loadDeletedProjects();
  }, [showTrash, activeTeamId, isOwner]);

  // ── Bulk operations ───────────────────────────────────────────────────────────
  async function bulkMoveToFolder(folderId: string | null) {
    const ids = Array.from(selectedProjects);
    await Promise.all(ids.map((id) => moveToFolder(id, folderId)));
    toast.success(`${ids.length} project${ids.length > 1 ? 's' : ''} moved`);
  }

  async function bulkToggleTag(tagId: string) {
    const ids = Array.from(selectedProjects);
    await Promise.all(ids.map((id) => toggleTag(id, tagId)));
  }

  async function moveProjectsToTrash(
    projectIds: string[],
    reason?: {
      reasonCode?: string;
      reasonLabel?: string;
      details?: string;
    },
  ) {
    if (projectIds.length === 0) return;
    const idSet = new Set(projectIds);
    await Promise.all(projectIds.map((id) => api.projects.delete(id, reason)));
    setProjects((prev) => prev.filter((p) => !idSet.has(p.id)));
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      projectIds.forEach((id) => next.delete(id));
      return next;
    });
    toast.success(
      `${projectIds.length} project${projectIds.length > 1 ? 's' : ''} moved to trash`,
    );
    if (isOwner && activeTeamId) loadDeletedProjects();
  }

  async function confirmBulkDelete() {
    if (bulkDeleteConfirmText.trim().toUpperCase() !== 'DELETE') {
      toast.error('Type "DELETE" to confirm');
      return;
    }

    setBulkDeleting(true);
    const ids = Array.from(selectedProjects);
    try {
      const selectedReason = DELETE_REASONS.find((x) => x.code === bulkDeleteReasonCode);
      await moveProjectsToTrash(ids, {
        reasonCode: bulkDeleteReasonCode,
        reasonLabel: selectedReason?.label || 'None of the above',
        details: bulkDeleteDetails.trim() || undefined,
      });
      setBulkDeleteConfirm(false);
      setBulkDeleteReasonCode('none');
      setBulkDeleteDetails('');
      setBulkDeleteConfirmText('');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to move to trash');
    } finally {
      setBulkDeleting(false);
    }
  }

  // ── Multi-select helpers ──────────────────────────────────────────────────────
  function toggleProjectSelection(projectId: string) {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedProjects.size === filtered.length) {
      setSelectedProjects(new Set());
    } else {
      setSelectedProjects(new Set(filtered.map((p) => p.id)));
    }
  }

  // ── DnD handlers ─────────────────────────────────────────────────────────────
  function handleDragStart(event: DragStartEvent) {
    setDropTargetId(null);
    const { active } = event;
    if (active.data.current?.type === DND_PROJECT) setActiveProject(projects.find((p) => p.id === active.id) ?? null);
    if (active.data.current?.type === DND_TAG)     setActiveTag(tags.find((t) => t.id === active.id) ?? null);
    if (active.data.current?.type === DND_FOLDER)  setActiveFolder(folders.find((f) => f.id === active.id) ?? null);
  }

  function handleDragOver(event: DragOverEvent) {
    if (event.active.data.current?.type !== DND_PROJECT) {
      setDropTargetId(null);
      return;
    }
    const id = event.over?.id != null ? String(event.over.id) : null;
    setDropTargetId(id);
  }

  function handleDragCancel(_event: DragCancelEvent) {
    setDropTargetId(null);
    setActiveProject(null);
    setActiveTag(null);
    setActiveFolder(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDropTargetId(null);
    setActiveProject(null);
    setActiveTag(null);
    setActiveFolder(null);
    if (!over) return;

    const activeType = active.data.current?.type;
    const overType   = over.data.current?.type;

    // ── Project → trash
    if (activeType === DND_PROJECT && overType === DND_TRASH) {
      const projectId = String(active.id);
      const ids =
        selectedProjects.has(projectId) && selectedProjects.size > 1
          ? Array.from(selectedProjects)
          : [projectId];
      void moveProjectsToTrash(ids).catch((err: any) => {
        toast.error(err?.message ?? 'Failed to move to trash');
      });
      return;
    }

    // ── Project → folder
    if (activeType === DND_PROJECT && overType === DND_FOLDER) {
      const folderId  = over.id === 'folder-none' ? null : String(over.id).replace('folder-', '');
      const projectId = String(active.id);
      if (selectedProjects.has(projectId) && selectedProjects.size > 1) {
        bulkMoveToFolder(folderId);
      } else {
        moveToFolder(projectId, folderId);
      }
      return;
    }

    // ── Tag → project
    if (activeType === DND_TAG && overType === DND_PROJECT) {
      const pId = String(over.id);
      if (selectedProjects.has(pId) && selectedProjects.size > 1) {
        bulkToggleTag(String(active.id));
      } else {
        toggleTag(pId, String(active.id));
      }
      return;
    }

    // ── Project → tag
    if (activeType === DND_PROJECT && overType === DND_TAG) {
      const tagId = String(over.id).replace('droptag-', '');
      const pId   = String(active.id);
      if (selectedProjects.has(pId) && selectedProjects.size > 1) {
        bulkToggleTag(tagId);
      } else {
        toggleTag(pId, tagId);
      }
      return;
    }

    // ── Folder → project
    if (activeType === DND_FOLDER && overType === DND_PROJECT) {
      const folderId  = String(active.id);
      const projectId = String(over.id);
      if (selectedProjects.has(projectId) && selectedProjects.size > 1) {
        bulkMoveToFolder(folderId);
      } else {
        moveToFolder(projectId, folderId);
      }
      return;
    }

    // ── Folder reorder
    if (activeType === DND_FOLDER && overType === DND_FOLDER) {
      const oldIdx = folders.findIndex((f) => f.id === active.id);
      const newIdx = folders.findIndex((f) => f.id === over.id);
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) setFolders(arrayMove(folders, oldIdx, newIdx));
      return;
    }

    // ── Tag reorder
    if (activeType === DND_TAG && overType === DND_TAG) {
      const oldIdx = tags.findIndex((t) => t.id === active.id);
      const newIdx = tags.findIndex((t) => t.id === over.id);
      if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) setTags(arrayMove(tags, oldIdx, newIdx));
    }
  }

  // ── Right-click handler (projects) ───────────────────────────────────────────
  function handleContextMenu(e: React.MouseEvent, project: ProjectListItem) {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, project, sub: null });
  }

  // ── Right-click handler (sidebar: folder or tag) ─────────────────────────────
  function handleSidebarContextMenu(
    e: React.MouseEvent,
    type: 'folder' | 'tag',
    item: ProjectFolder | ProjectTag,
  ) {
    e.preventDefault();
    e.stopPropagation();
    setSidebarCtx({ type, item, x: e.clientX, y: e.clientY });
  }

  const hasActiveFilter = !!(statusFilter || thisMonthOnly || selectedTags.length > 0);

  const projectDragActive = activeProject !== null;

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={customCollision}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      {/* -m-6 escapes the dashboard layout's p-6 padding */}
      <div className="-mx-6 -mt-6 -mb-6 flex flex-col overflow-hidden" style={{ height: 'calc(100vh - 3.5rem)' }}>

        {/* ── Top bar ──────────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-card shrink-0">
          <button
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mr-1"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Dashboard
          </button>

          {/* Search */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects…"
              className="w-full rounded-lg border bg-background pl-9 pr-4 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>

          {/* Sort dropdown */}
          <div ref={sortRef} className="relative">
            <button
              onClick={() => setSortOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <SortAsc className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="hidden sm:inline">{SORT_OPTIONS.find((o) => o.value === sortBy)?.label ?? 'Sort'}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            {sortOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border bg-card shadow-lg animate-fade-in">
                <div className="p-1">
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setSortBy(opt.value); setSortOpen(false); }}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors ${sortBy === opt.value ? 'text-primary font-medium' : ''}`}
                    >
                      {sortBy === opt.value && <Check className="h-3.5 w-3.5" />}
                      <span className={sortBy === opt.value ? '' : 'ml-5'}>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Button variant="outline" size="icon" className="h-8 w-8" onClick={loadAll}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <div className="inline-flex items-center rounded-lg border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`rounded-md p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              title="Grid view"
              aria-label="Grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`rounded-md p-1.5 transition-colors ${viewMode === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              title="List view"
              aria-label="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <Button onClick={() => setDialogOpen(true)} size="sm" className="bg-brand-gradient text-white border-0 hover:opacity-90">
            <Plus className="mr-1 h-3.5 w-3.5" /> New Project
          </Button>
        </div>

        {/* ── Bulk selection toolbar ────────────────────────────────────────────── */}
        {selectedProjects.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 border-b bg-primary/5 shrink-0">
            <input
              type="checkbox"
              checked={selectedProjects.size === filtered.length && filtered.length > 0}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
            />
            <span className="text-sm font-medium">
              {selectedProjects.size} of {filtered.length} selected
            </span>

            {/* Move to folder */}
            <BulkFolderMenu
              folders={folders}
              onMove={bulkMoveToFolder}
              onQuickCreate={quickCreateFolder}
            />

            {/* Add tag */}
            <BulkTagMenu
              tags={tags}
              selectedProjects={selectedProjects}
              projects={projects}
              onToggle={bulkToggleTag}
              onQuickCreate={quickCreateTag}
            />

            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setBulkDeleteReasonCode('none');
                  setBulkDeleteDetails('');
                  setBulkDeleteConfirmText('');
                  setBulkDeleteConfirm(true);
                }}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete {selectedProjects.size} Project{selectedProjects.size > 1 ? 's' : ''}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedProjects(new Set())}>
                <X className="mr-1 h-3.5 w-3.5" /> Clear
              </Button>
            </div>
          </div>
        )}

        {/* ── Active filter pills ───────────────────────────────────────────────── */}
        {hasActiveFilter && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b shrink-0">
            {statusFilter && (
              <span className="inline-flex items-center gap-1.5 rounded-full border bg-primary/5 px-3 py-0.5 text-xs font-medium text-primary">
                Status: {statusFilter.charAt(0) + statusFilter.slice(1).toLowerCase()}
                <button onClick={() => setStatusFilter(null)}><X className="h-3 w-3" /></button>
              </span>
            )}
            {thisMonthOnly && (
              <span className="inline-flex items-center gap-1.5 rounded-full border bg-primary/5 px-3 py-0.5 text-xs font-medium text-primary">
                Created This Month
                <button onClick={() => setThisMonthOnly(false)}><X className="h-3 w-3" /></button>
              </span>
            )}
            {selectedTags.map((tid) => {
              const tag = tags.find((t) => t.id === tid);
              return tag ? (
                <span key={tid} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs font-medium" style={{ color: tag.color, borderColor: tag.color + '44' }}>
                  {tag.name}
                  <button onClick={() => setSelectedTags((prev) => prev.filter((t) => t !== tid))}><X className="h-3 w-3" /></button>
                </span>
              ) : null;
            })}
            <button
              onClick={() => { setStatusFilter(null); setThisMonthOnly(false); setSelectedTags([]); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors underline-offset-2 hover:underline"
            >
              Clear all
            </button>
          </div>
        )}

        {/* ── Body: sidebar + main ─────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* ── Sidebar ──────────────────────────────────────────────────────── */}
          <aside className="hidden lg:flex w-56 flex-col border-r bg-card shrink-0 overflow-hidden">
            {/* Folders header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-1 shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Folders</span>
              <button
                onClick={() => { setFolderModal({ open: true }); setFolderName(''); setFolderColor(COLORS[0]); }}
                className="rounded p-0.5 hover:bg-accent transition-colors"
                title="New folder"
              >
                <FolderPlus className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>

            {/* Scrollable sidebar content */}
            <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-0.5">
              <AllFolderDrop
                active={selectedFolder === 'all'}
                count={projects.length}
                onClick={() => setSelectedFolder('all')}
                dropHighlight={projectDragActive && dropTargetId === 'folder-none'}
              />
              <SortableContext items={folders.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                {folders.map((folder) => (
                  <SortableFolderItem
                    key={folder.id}
                    folder={folder}
                    active={selectedFolder === folder.id}
                    count={projects.filter((p) => p.folderId === folder.id).length}
                    onClick={() => setSelectedFolder(folder.id)}
                    onEdit={() => { setFolderModal({ open: true, editing: folder }); setFolderName(folder.name); setFolderColor(folder.color); }}
                    onDelete={() => deleteFolder(folder.id)}
                    onContextMenu={(e) => handleSidebarContextMenu(e, 'folder', folder)}
                    dropHighlight={
                      projectDragActive &&
                      (dropTargetId === folder.id || dropTargetId === `folder-${folder.id}`)
                    }
                  />
                ))}
              </SortableContext>

              {/* Tags header */}
              <div className="flex items-center justify-between px-1 pt-5 pb-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tags</span>
                <button
                  onClick={() => { setTagModal({ open: true }); setTagName(''); setTagColor(COLORS[1]); }}
                  className="rounded p-0.5 hover:bg-accent transition-colors"
                  title="New tag"
                >
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>

              <SortableContext items={tags.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                {tags.map((tag) => (
                  <DraggableTag
                    key={tag.id}
                    tag={tag}
                    count={tagProjectCount[tag.id] ?? 0}
                    selected={selectedTags.includes(tag.id)}
                    onToggle={() =>
                      setSelectedTags((prev) =>
                        prev.includes(tag.id) ? prev.filter((t) => t !== tag.id) : [...prev, tag.id]
                      )
                    }
                    onEdit={() => { setTagModal({ open: true, editing: tag }); setTagName(tag.name); setTagColor(tag.color); }}
                    onDelete={() => deleteTag(tag.id)}
                    onContextMenu={(e) => handleSidebarContextMenu(e, 'tag', tag)}
                    dropHighlight={
                      projectDragActive &&
                      (dropTargetId === tag.id || dropTargetId === `droptag-${tag.id}`)
                    }
                  />
                ))}
              </SortableContext>
              {tags.length === 0 && (
                <p className="px-2 text-xs text-muted-foreground/50 mt-1">No tags yet</p>
              )}

              {/* Trash (only visible to team owner) */}
              {isOwner && (
                <TrashDropZone
                  showTrash={showTrash}
                  deletedCount={deletedProjects.length}
                  dropHighlight={projectDragActive && dropTargetId === 'droppable-trash'}
                  onClick={() => {
                    setShowTrash(!showTrash);
                    setSelectedFolder('all');
                  }}
                />
              )}
            </div>
          </aside>

          {/* ── Main content ──────────────────────────────────────────────────── */}
          <main className="flex-1 overflow-y-auto">
            {showTrash ? (
              /* ── Trash view ────────────────────────────────────────────────────── */
              <div className="p-6">
                <div className="flex items-center gap-3 mb-6">
                  <button
                    onClick={() => setShowTrash(false)}
                    className="rounded-lg p-1.5 hover:bg-accent transition-colors"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <Trash2 className="h-5 w-5 text-destructive" />
                  <h2 className="text-lg font-semibold">Deleted Projects</h2>
                  <span className="text-sm text-muted-foreground">({deletedProjects.length})</span>
                </div>

                {loadingTrash ? (
                  <div className="kb-grid-row-hover grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="rounded-xl border bg-card h-32 animate-pulse" />
                    ))}
                  </div>
                ) : deletedProjects.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                    <Trash2 className="h-12 w-12 mb-3 opacity-30" />
                    <p className="text-sm font-medium">Trash is empty</p>
                    <p className="text-xs mt-1">Deleted projects will appear here</p>
                  </div>
                ) : (
                  <div className="kb-grid-row-hover grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {deletedProjects.map((project) => {
                      const displayName = project.name.replace(/_(\d+_)?deleted$/, '');
                      return (
                      <div
                        key={project.id}
                        className="group relative rounded-xl border border-destructive/20 bg-card p-4 hover:border-destructive/40 transition-colors"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-medium truncate text-muted-foreground line-through">
                              {displayName}
                            </h3>
                            {project.description && (
                              <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{project.description}</p>
                            )}
                          </div>
                        </div>
                        <p className="text-[10px] text-muted-foreground/50 mb-3">
                          {(() => {
                            if (!project.updatedAt) return 'Deleted';
                            const d = new Date(project.updatedAt);
                            const deletedAt = d.getTime();
                            const timeStr = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                            const dateStr = d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
                            const expiresAt = deletedAt + 24 * 60 * 60 * 1000;
                            const remaining = expiresAt - Date.now();
                            if (remaining <= 0) return `Deleted ${dateStr} ${timeStr} · Expires soon`;
                            const hours = Math.floor(remaining / 3600000);
                            const mins = Math.floor((remaining % 3600000) / 60000);
                            const rem = hours > 0 ? `${hours}h ${mins}m remaining` : `${mins}m remaining`;
                            return `Deleted ${dateStr} ${timeStr} · ${rem}`;
                          })()}
                        </p>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleRestore(project.id)}
                            disabled={restoringId === project.id}
                            className="flex items-center gap-1.5 rounded-lg bg-primary/10 text-primary px-3 py-1.5 text-xs font-medium hover:bg-primary/20 transition-colors disabled:opacity-50"
                          >
                            <RotateCcw className={`h-3 w-3 ${restoringId === project.id ? 'animate-spin' : ''}`} />
                            {restoringId === project.id ? 'Restoring...' : 'Restore'}
                          </button>
                          <button
                            onClick={() => setPermDeleteConfirm(project)}
                            className="flex items-center gap-1.5 rounded-lg bg-destructive/10 text-destructive px-3 py-1.5 text-xs font-medium hover:bg-destructive/20 transition-colors"
                          >
                            <Trash2 className="h-3 w-3" />
                            Delete Forever
                          </button>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
            <>
            {/* Select-all bar */}
            {!loading && filtered.length > 0 && (
              <div className="flex items-center gap-2.5 px-6 py-2.5 border-b bg-card/60 shrink-0 sticky top-0 z-10">
                <input
                  type="checkbox"
                  checked={selectedProjects.size === filtered.length && filtered.length > 0}
                  onChange={toggleSelectAll}
                  className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                />
                <span className="text-xs text-muted-foreground">
                  {selectedProjects.size > 0
                    ? `${selectedProjects.size} of ${filtered.length} selected`
                    : `${filtered.length} project${filtered.length !== 1 ? 's' : ''}`}
                </span>
              </div>
            )}

            <div className="p-6">
              {loading ? (
                viewMode === 'grid' ? (
                  <div className="kb-grid-row-hover grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="rounded-xl border bg-card h-48 animate-pulse" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-16 rounded-lg border bg-card animate-pulse" />
                    ))}
                  </div>
                )
              ) : filtered.length === 0 ? (
                <EmptyState
                  onNew={() => setDialogOpen(true)}
                  hasFilters={selectedFolder !== 'all' || selectedTags.length > 0 || !!searchQuery || !!statusFilter || thisMonthOnly}
                />
              ) : (
                viewMode === 'grid' ? (
                  <div className="kb-grid-row-hover grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filtered.map((project) => (
                      <DroppableProjectCard
                        key={project.id}
                        project={project}
                        folders={folders}
                        allTags={tags}
                        isSelected={selectedProjects.has(project.id)}
                        hasSelection={selectedProjects.size > 0}
                        onOpen={() => openProject(project.id)}
                        onSelect={() => toggleProjectSelection(project.id)}
                        onMoveFolder={(fid) => moveToFolder(project.id, fid)}
                        onToggleTag={(tid) => toggleTag(project.id, tid)}
                        onContextMenu={(e) => handleContextMenu(e, project)}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filtered.map((project) => (
                      <ProjectListRow
                        key={project.id}
                        project={project}
                        isSelected={selectedProjects.has(project.id)}
                        onOpen={() => openProject(project.id)}
                        onSelect={() => toggleProjectSelection(project.id)}
                        onContextMenu={(e) => handleContextMenu(e, project)}
                      />
                    ))}
                  </div>
                )
              )}
            </div>
            </>
            )}
          </main>
        </div>
      </div>

      {/* Permanent delete confirmation */}
      {permDeleteConfirm && (
        <Modal
          onClose={() => setPermDeleteConfirm(null)}
          title="Permanently Delete Project"
        >
          <p className="text-sm text-muted-foreground mb-1">
            This will permanently destroy the project <strong className="text-foreground">&quot;{permDeleteConfirm.name.replace(/_(\d+_)?deleted$/, '')}&quot;</strong>, including its database, users, and all data.
          </p>
          <p className="text-xs text-destructive font-medium mb-4">This action cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPermDeleteConfirm(null)}
              className="rounded-lg border px-4 py-2 text-sm hover:bg-accent transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePermanentDelete}
              disabled={permDeleting}
              className="rounded-lg bg-destructive text-destructive-foreground px-4 py-2 text-sm font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
            >
              {permDeleting ? 'Deleting...' : 'Delete Forever'}
            </button>
          </div>
        </Modal>
      )}

      {/* DnD overlay */}
      <DragOverlay>
        {activeProject && (
          <ProjectCardOverlay
            project={activeProject}
            selectionCount={selectedProjects.has(activeProject.id) ? selectedProjects.size : 1}
          />
        )}
        {activeTag && (
          <span className="tag-pill border shadow-lg" style={{ color: activeTag.color, borderColor: activeTag.color + '44', background: 'hsl(var(--card))' }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: activeTag.color }} />
            {activeTag.name}
          </span>
        )}
        {activeFolder && (
          <span className="inline-flex items-center gap-1.5 rounded-md border bg-card shadow-lg px-2.5 py-1.5 text-sm font-medium">
            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: activeFolder.color }} />
            {activeFolder.name}
          </span>
        )}
      </DragOverlay>

      {/* Right-click context menu */}
      {ctxMenu && (
        <ContextMenu
          ref={ctxRef}
          x={ctxMenu.x}
          y={ctxMenu.y}
          project={ctxMenu.project}
          folders={folders}
          tags={tags}
          teams={teams}
          currentTeamId={activeTeamId}
          sub={ctxMenu.sub}
          onSetSub={(sub) => setCtxMenu((c) => c ? { ...c, sub } : null)}
          onClose={() => setCtxMenu(null)}
          onGoDetails={() => { openProject(ctxMenu.project.id); setCtxMenu(null); }}
          onMoveFolder={(fid) => { moveToFolder(ctxMenu.project.id, fid); setCtxMenu(null); }}
          onToggleTag={(tid) => { toggleTag(ctxMenu.project.id, tid); }}
          onMoveTeam={(team) => { setMoveTeamModal({ project: ctxMenu.project, targetTeam: team }); setCtxMenu(null); }}
          onEdit={() => { openEditModal(ctxMenu.project); setCtxMenu(null); }}
          onDelete={() => { setDeleteConfirm(ctxMenu.project); setCtxMenu(null); }}
        />
      )}

      {/* Sidebar context menu (folder / tag) */}
      {sidebarCtx && (
        <SidebarContextMenu
          ref={sidebarCtxRef}
          x={sidebarCtx.x}
          y={sidebarCtx.y}
          type={sidebarCtx.type}
          onEdit={() => {
            if (sidebarCtx.type === 'folder') {
              const f = sidebarCtx.item as ProjectFolder;
              setFolderModal({ open: true, editing: f });
              setFolderName(f.name);
              setFolderColor(f.color);
            } else {
              const t = sidebarCtx.item as ProjectTag;
              setTagModal({ open: true, editing: t });
              setTagName(t.name);
              setTagColor(t.color);
            }
            setSidebarCtx(null);
          }}
          onDelete={() => {
            if (sidebarCtx.type === 'folder') deleteFolder((sidebarCtx.item as ProjectFolder).id);
            else deleteTag((sidebarCtx.item as ProjectTag).id);
            setSidebarCtx(null);
          }}
          onClose={() => setSidebarCtx(null)}
        />
      )}

      {/* Folder modal */}
      {folderModal.open && (
        <Modal title={folderModal.editing ? 'Edit Folder' : 'New Folder'} size="md" onClose={() => setFolderModal({ open: false })}>
          <input
            autoFocus value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveFolder()}
            placeholder="Folder name"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/50 mb-3"
          />
          <ColorPicker value={folderColor} onChange={setFolderColor} />
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setFolderModal({ open: false })}>Cancel</Button>
            <Button className="flex-1 bg-brand-gradient text-white border-0 hover:opacity-90" onClick={saveFolder}>
              {folderModal.editing ? 'Save' : 'Create'}
            </Button>
          </div>
        </Modal>
      )}

      {/* Tag modal (create / edit) */}
      {tagModal.open && (
        <Modal title={tagModal.editing ? 'Edit Tag' : 'New Tag'} size="md" onClose={() => setTagModal({ open: false })}>
          <input
            autoFocus value={tagName}
            onChange={(e) => setTagName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveTag()}
            placeholder="Tag name"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/50 mb-3"
          />
          <ColorPicker value={tagColor} onChange={setTagColor} />
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setTagModal({ open: false })}>Cancel</Button>
            <Button className="flex-1 bg-brand-gradient text-white border-0 hover:opacity-90" onClick={saveTag}>
              {tagModal.editing ? 'Save' : 'Create'}
            </Button>
          </div>
        </Modal>
      )}

      <CreateProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={loadAll}
        teamId={activeTeamId}
      />

      {/* ── Edit project modal ─────────────────────────────────────────────── */}
      {editModal.open && editModal.project && (
        <Modal title="Edit Project" onClose={() => setEditModal({ open: false, project: null })}>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Name</label>
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveEditProject()}
                placeholder="Project name"
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
              <textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Project description (optional)"
                rows={3}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/50 resize-none"
              />
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setEditModal({ open: false, project: null })}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-brand-gradient text-white border-0 hover:opacity-90"
              onClick={saveEditProject}
              disabled={editSaving || !editName.trim()}
            >
              {editSaving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Modal>
      )}

      {/* ── Single delete confirm modal ───────────────────────────────────── */}
      {deleteConfirm && (
        <Modal title="Move to Trash" onClose={() => setDeleteConfirm(null)}>
          <p className="text-sm text-muted-foreground mb-1">
            Move to trash:
          </p>
          <p className="text-sm font-semibold mb-3">&quot;{deleteConfirm.name}&quot;</p>
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 mb-4">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              This project will remain in trash for <strong>24 hours</strong>. The team owner can restore it during this period. After 24 hours it will be permanently deleted.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={confirmDeleteProject}
              disabled={deleting}
            >
              {deleting ? 'Moving…' : 'Move to Trash'}
            </Button>
          </div>
        </Modal>
      )}

      {/* ── Bulk delete confirm modal ─────────────────────────────────────── */}
      {bulkDeleteConfirm && (
        <Modal
          title="Move to Trash"
          onClose={() => {
            setBulkDeleteConfirm(false);
            setBulkDeleteReasonCode('none');
            setBulkDeleteDetails('');
            setBulkDeleteConfirmText('');
          }}
        >
          <p className="text-sm text-muted-foreground mb-2">
            Move to trash {selectedProjects.size} selected project{selectedProjects.size > 1 ? 's' : ''}.
          </p>
          <div className="mb-3 max-h-28 overflow-auto rounded-lg border bg-muted/30 p-2">
            {Array.from(selectedProjects).map((id) => {
              const project = projects.find((p) => p.id === id);
              if (!project) return null;
              return (
                <p key={id} className="truncate text-xs text-muted-foreground" title={project.name}>
                  - {project.name}
                </p>
              );
            })}
          </div>
          <div className="mb-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Reason for deletion</p>
            <div className="max-h-28 overflow-auto rounded-lg border p-2">
              <div className="flex flex-wrap gap-1.5">
                {DELETE_REASONS.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => setBulkDeleteReasonCode(r.code)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      bulkDeleteReasonCode === r.code
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mb-4">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Additional details (optional)
            </label>
            <textarea
              value={bulkDeleteDetails}
              onChange={(e) => setBulkDeleteDetails(e.target.value)}
              rows={3}
              placeholder="Tell us why these projects are being deleted..."
              className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/50"
            />
          </div>
          <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 mb-4">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              These projects will remain in trash for <strong>24 hours</strong>. The team owner can restore them during this period. After 24 hours they will be permanently deleted.
            </p>
          </div>
          <div className="mb-4">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Type <span className="font-semibold text-foreground">DELETE</span> to confirm.
            </label>
            <Input
              value={bulkDeleteConfirmText}
              onChange={(e) => setBulkDeleteConfirmText(e.target.value)}
              placeholder="DELETE"
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setBulkDeleteConfirm(false);
                setBulkDeleteReasonCode('none');
                setBulkDeleteDetails('');
                setBulkDeleteConfirmText('');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={confirmBulkDelete}
              disabled={bulkDeleting || bulkDeleteConfirmText.trim().toUpperCase() !== 'DELETE'}
            >
              {bulkDeleting ? 'Moving…' : `Move ${selectedProjects.size} to Trash`}
            </Button>
          </div>
        </Modal>
      )}

      {/* ── Move to team confirm modal ───────────────────────────────────────── */}
      {moveTeamModal && (
        <Modal title="Move Project to Team" onClose={() => setMoveTeamModal(null)}>
          <p className="text-sm text-muted-foreground mb-1">
            Move <span className="font-semibold text-foreground">&quot;{moveTeamModal.project.name}&quot;</span> to
          </p>
          <div className="flex items-center gap-2 my-3 rounded-lg border bg-accent/40 px-3 py-2">
            <span className="h-7 w-7 rounded-full bg-brand-gradient flex items-center justify-center text-white text-xs font-bold shrink-0">
              {moveTeamModal.targetTeam.name.charAt(0).toUpperCase()}
            </span>
            <span className="font-medium text-sm">{moveTeamModal.targetTeam.name}</span>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            The project will be removed from the current team and its folder assignment will be cleared.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setMoveTeamModal(null)}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-brand-gradient text-white border-0 hover:opacity-90"
              onClick={handleMoveToTeam}
              disabled={movingTeam}
            >
              {movingTeam ? 'Moving…' : 'Move Project'}
            </Button>
          </div>
        </Modal>
      )}
    </DndContext>
  );
}

function ProjectListRow({
  project,
  isSelected,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  project: ProjectListItem;
  isSelected: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onOpen}
      onContextMenu={onContextMenu}
      className={`flex cursor-pointer items-center gap-3 rounded-lg border bg-card px-3 py-2 transition-colors hover:bg-accent/40 ${
        isSelected ? 'ring-2 ring-primary border-primary/50' : ''
      }`}
    >
      <span
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 ${
          isSelected ? 'bg-primary border-primary' : 'border-muted-foreground/30'
        }`}
      >
        {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
      </span>
      <Database className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={project.name}>
          {project.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          Created by {project.createdByName ?? 'Unknown'} - {formatDateTime(project.createdAt)} - Size: {formatSize(project.projectSizeBytes)}
        </p>
      </div>
      <span className={`status-badge ${STATUS_COLORS[project.status] ?? 'status-pending'}`}>
        {project.status}
      </span>
    </div>
  );
}

// ── BulkFolderMenu ────────────────────────────────────────────────────────────
function BulkFolderMenu({
  folders,
  onMove,
  onQuickCreate,
}: {
  folders: ProjectFolder[];
  onMove: (fid: string | null) => void;
  onQuickCreate: () => Promise<ProjectFolder | null>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-sm hover:bg-accent transition-colors"
      >
        <FolderOpen className="h-3.5 w-3.5" /> Move to folder <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border bg-card shadow-lg">
          <div className="p-1">
            <button
              onClick={() => { onMove(null); setOpen(false); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors text-muted-foreground"
            >
              <FolderOpen className="h-3.5 w-3.5" /> No folder (remove)
            </button>
            {folders.length === 0 && (
              <button
                onClick={async () => {
                  const created = await onQuickCreate();
                  if (created) {
                    onMove(created.id);
                    setOpen(false);
                  }
                }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors text-primary"
              >
                <Plus className="h-3.5 w-3.5" /> Create new folder
              </button>
            )}
            {folders.map((f) => (
              <button
                key={f.id}
                onClick={() => { onMove(f.id); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: f.color }} />
                {f.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── BulkTagMenu ───────────────────────────────────────────────────────────────
function BulkTagMenu({
  tags, selectedProjects, projects, onToggle, onQuickCreate,
}: {
  tags: ProjectTag[];
  selectedProjects: Set<string>;
  projects: ProjectListItem[];
  onToggle: (tagId: string) => void;
  onQuickCreate: () => Promise<ProjectTag | null>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-sm hover:bg-accent transition-colors"
      >
        <Tag className="h-3.5 w-3.5" /> Add tag <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-lg border bg-card shadow-lg">
          <div className="p-1">
            {tags.length === 0 && (
              <>
                <p className="px-3 py-2 text-xs text-muted-foreground">No tags yet</p>
                <button
                  onClick={async () => {
                    const created = await onQuickCreate();
                    if (created) {
                      onToggle(created.id);
                      setOpen(false);
                    }
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors text-primary"
                >
                  <Plus className="h-3.5 w-3.5" /> Create new tag
                </button>
              </>
            )}
            {tags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => { onToggle(tag.id); setOpen(false); }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors"
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: tag.color }} />
                <span style={{ color: tag.color }}>{tag.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── TrashDropZone (droppable for project → trash) ──────────────────────────────
function TrashDropZone({
  showTrash,
  deletedCount,
  dropHighlight,
  onClick,
}: {
  showTrash: boolean;
  deletedCount: number;
  dropHighlight?: boolean;
  onClick: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: 'droppable-trash',
    data: { type: DND_TRASH },
  });
  const trashOver = isOver || dropHighlight;
  const rowClass =
    trashOver
      ? 'bg-destructive/15 text-destructive font-medium ring-2 ring-destructive/50'
      : showTrash
        ? 'bg-destructive/10 text-destructive font-medium'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground';
  const badgeClass =
    trashOver || showTrash
      ? 'bg-destructive/25 text-destructive'
      : 'bg-muted text-muted-foreground';
  return (
    <div ref={setNodeRef} className="mt-5 pt-3 border-t border-border/50">
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full min-h-9 items-center gap-2 rounded-lg px-2 py-2 text-xs transition-colors ${rowClass}`}
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" />
        <span>Trash</span>
        {deletedCount > 0 && (
          <span className={`ml-auto text-[10px] rounded-full px-1.5 py-0.5 ${badgeClass}`}>
            {deletedCount}
          </span>
        )}
      </button>
    </div>
  );
}

// ── AllFolderDrop ─────────────────────────────────────────────────────────────
function AllFolderDrop({
  active,
  count,
  onClick,
  dropHighlight,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  dropHighlight?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'folder-none', data: { type: DND_FOLDER } });
  const drop = isOver || dropHighlight;
  return (
    <div ref={setNodeRef} onClick={onClick}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors w-full cursor-pointer select-none ${
        drop ? SIDEBAR_DROP_ROW :
        active ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent text-foreground/80'
      }`}
    >
      <FolderOpen className={`h-3.5 w-3.5 shrink-0 ${drop ? 'text-primary' : ''}`} />
      <span className="flex-1 truncate">All Projects</span>
      <span className={`text-xs tabular-nums ${drop ? 'text-primary/80' : 'text-muted-foreground'}`}>{count}</span>
    </div>
  );
}

// ── SortableFolderItem ────────────────────────────────────────────────────────
function SortableFolderItem({
  folder, active, count, onClick, onEdit, onDelete, onContextMenu, dropHighlight,
}: {
  folder: ProjectFolder;
  active: boolean;
  count: number;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  dropHighlight?: boolean;
}) {
  const { attributes, listeners, setNodeRef: setSortRef, transform, transition, isDragging } = useSortable({
    id: folder.id,
    data: { type: DND_FOLDER },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-${folder.id}`,
    data: { type: DND_FOLDER },
  });

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const drop = isOver || dropHighlight;

  return (
    <div
      ref={(el) => { setSortRef(el); setDropRef(el); }}
      style={style}
      {...attributes}
      onContextMenu={onContextMenu}
      className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors w-full select-none ${
        drop ? SIDEBAR_DROP_ROW :
        active ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent text-foreground/80'
      }`}
      onClick={() => { if (!isDragging) onClick(); }}
    >
      {/* Grip handle – only this element starts a drag */}
      <span
        {...listeners}
        className={`shrink-0 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className={`h-3 w-3 ${drop ? 'text-primary/40' : 'text-muted-foreground/30'}`} />
      </span>
      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: folder.color }} />
      <span className="flex-1 truncate">{folder.name}</span>
      <span className={`text-xs tabular-nums ${drop ? 'text-primary/80' : 'text-muted-foreground'}`}>{count}</span>
      <span className="hidden group-hover:flex items-center gap-0.5">
        <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="rounded p-0.5 hover:bg-muted">
          <Pencil className="h-3 w-3 text-muted-foreground" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="rounded p-0.5 hover:bg-destructive/10">
          <Trash2 className="h-3 w-3 text-muted-foreground" />
        </button>
      </span>
    </div>
  );
}

// ── DraggableTag ──────────────────────────────────────────────────────────────
function DraggableTag({
  tag, count, selected, onToggle, onEdit, onDelete, onContextMenu, dropHighlight,
}: {
  tag: ProjectTag;
  count: number;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  dropHighlight?: boolean;
}) {
  const { attributes, listeners, setNodeRef: setSortRef, transform, transition, isDragging } = useSortable({
    id: tag.id,
    data: { type: DND_TAG },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `droptag-${tag.id}`,
    data: { type: DND_TAG },
  });

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 };
  const drop = isOver || dropHighlight;

  return (
    <div
      ref={(el) => { setSortRef(el); setDropRef(el); }}
      style={style}
      {...attributes}
      onContextMenu={onContextMenu}
      className={`group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors select-none ${
        drop ? SIDEBAR_DROP_ROW :
        selected ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent'
      }`}
      onClick={() => { if (!isDragging) onToggle(); }}
      title="Click to filter · Drag onto a project to assign"
    >
      {/* Grip handle – only this element starts a drag */}
      <span
        {...listeners}
        className={`shrink-0 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className={`h-3 w-3 ${drop ? 'text-primary/40' : 'text-muted-foreground/30'}`} />
      </span>
      <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: tag.color }} />
      <span className="flex-1 truncate">{tag.name}</span>
      {drop
        ? <span className="text-[10px] text-primary font-medium shrink-0">+tag</span>
        : count > 0 && <span className="text-xs tabular-nums text-muted-foreground shrink-0">{count}</span>
      }
      <span className="hidden group-hover:flex items-center gap-0.5">
        <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="rounded p-0.5 hover:bg-muted">
          <Pencil className="h-3 w-3 text-muted-foreground" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }} className="rounded p-0.5 hover:bg-destructive/10">
          <Trash2 className="h-3 w-3 text-muted-foreground" />
        </button>
      </span>
    </div>
  );
}

// ── SidebarContextMenu ────────────────────────────────────────────────────────
const SidebarContextMenu = React.forwardRef<HTMLDivElement, {
  x: number;
  y: number;
  type: 'folder' | 'tag';
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}>(function SidebarContextMenu({ x, y, type, onEdit, onDelete, onClose }, ref) {
  const left = Math.min(x, window.innerWidth - 200);
  const top  = Math.min(y, window.innerHeight - 110);
  return (
    <div
      ref={ref}
      className="fixed z-[9999] w-48 rounded-xl border bg-card shadow-xl animate-fade-in"
      style={{ left, top }}
    >
      <div className="p-1">
        <button
          onClick={onEdit}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors"
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          Edit {type === 'folder' ? 'Folder' : 'Tag'}
        </button>
        <div className="my-1 h-px bg-border" />
        <button
          onClick={onDelete}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete {type === 'folder' ? 'Folder' : 'Tag'}
        </button>
      </div>
    </div>
  );
});

// ── DroppableProjectCard ──────────────────────────────────────────────────────
function DroppableProjectCard({
  project, folders, allTags, isSelected, hasSelection,
  onOpen, onSelect, onMoveFolder, onToggleTag, onContextMenu,
}: {
  project: ProjectListItem;
  folders: ProjectFolder[];
  allTags: ProjectTag[];
  isSelected: boolean;
  hasSelection: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onMoveFolder: (folderId: string | null) => void;
  onToggleTag: (tagId: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: project.id,
    data: { type: DND_PROJECT },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: project.id,
    data: { type: DND_PROJECT },
  });

  const style = { transform: CSS.Transform.toString(transform), opacity: isDragging ? 0.35 : 1 };

  return (
    <div
      ref={(el) => { setDragRef(el); setDropRef(el); }}
      style={style}
      {...attributes}
      {...listeners}
      onContextMenu={onContextMenu}
      className={`rounded-xl border bg-card p-4 flex flex-col gap-3 relative transition-all select-none ${
        isSelected
          ? 'ring-2 ring-primary border-primary/50 bg-primary/[0.02]'
          : isOver
          ? 'ring-2 ring-primary/50 bg-primary/5 scale-[1.01]'
          : 'hover:shadow-md'
      } ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      onClick={(e) => {
        if (isDragging) return;
        onOpen();
      }}
    >
      {/* Status + selection checkbox */}
      <div className="flex items-start justify-between gap-2">
        <span className={`status-badge ${STATUS_COLORS[project.status] ?? 'status-pending'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[project.status] ?? 'bg-gray-400'}`} />
          {project.status.charAt(0) + project.status.slice(1).toLowerCase()}
        </span>
        {/* Checkbox – always visible, click to select */}
        <span
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors cursor-pointer ${
            isSelected
              ? 'bg-primary border-primary'
              : 'border-muted-foreground/30 bg-card hover:border-primary'
          }`}
        >
          {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
        </span>
      </div>

      {/* Name + description */}
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-brand-gradient">
            <Database className="h-4 w-4 text-white" />
          </div>
          <h3 className="font-semibold truncate" title={project.name}>
            {project.name}
          </h3>
        </div>
        {project.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 ml-10">{project.description}</p>
        )}
      </div>

      {/* Folder pill */}
      {project.folder && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ background: project.folder.color }} />
          <span className="truncate">{project.folder.name}</span>
        </div>
      )}

      {/* Tags */}
      {(project.tags ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(project.tags ?? []).slice(0, 4).map(({ tag }) => (
            <span key={tag.id} className="tag-pill" style={{ color: tag.color, borderColor: tag.color + '44' }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color }} />
              {tag.name}
            </span>
          ))}
          {(project.tags ?? []).length > 4 && (
            <span className="tag-pill text-muted-foreground border-muted-foreground/20">
              +{(project.tags ?? []).length - 4}
            </span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="space-y-1 pt-1 border-t">
        <p className="text-xs text-muted-foreground">
          Created by {project.createdByName ?? 'Unknown'}
        </p>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Calendar className="h-3 w-3" />
          <span>{formatDateTime(project.createdAt)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            <span>Size: {formatSize(project.projectSizeBytes)}</span>
          </div>
          <div className="flex items-center gap-1">
            <Zap className="h-3 w-3" />
            <span className="font-mono text-[10px]">{project.slug}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── ProjectCardOverlay (drag ghost) ──────────────────────────────────────────
function ProjectCardOverlay({ project, selectionCount }: { project: ProjectListItem; selectionCount: number }) {
  return (
    <div className="rounded-xl border bg-card shadow-xl p-4 w-64 opacity-90 rotate-1">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-brand-gradient">
          <Database className="h-4 w-4 text-white" />
        </div>
        <span className="font-semibold truncate">{project.name}</span>
        {selectionCount > 1 && (
          <span className="ml-auto flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white px-1">
            {selectionCount}
          </span>
        )}
      </div>
    </div>
  );
}

// ── ContextMenu ───────────────────────────────────────────────────────────────
const ContextMenu = React.forwardRef<HTMLDivElement, {
  x: number; y: number;
  project: ProjectListItem;
  folders: ProjectFolder[];
  tags: ProjectTag[];
  teams: Team[];
  currentTeamId: string;
  sub: null | 'folder' | 'tag' | 'team';
  onSetSub: (s: null | 'folder' | 'tag' | 'team') => void;
  onClose: () => void;
  onGoDetails: () => void;
  onMoveFolder: (fid: string | null) => void;
  onToggleTag: (tid: string) => void;
  onMoveTeam: (team: Team) => void;
  onEdit: () => void;
  onDelete: () => void;
}>(function ContextMenu({ x, y, project, folders, tags, teams, currentTeamId, sub, onSetSub, onClose, onGoDetails, onMoveFolder, onToggleTag, onMoveTeam, onEdit, onDelete }, ref) {
  const projectTagIds = (project.tags ?? []).map((t) => t.tag.id);
  const otherTeams = teams.filter((t) => t.id !== currentTeamId);
  const left = Math.min(x, window.innerWidth - 232);
  const top  = Math.min(y, window.innerHeight - 220);

  return (
    <div ref={ref} className="fixed z-[9999] w-56 rounded-xl border bg-card shadow-xl animate-fade-in overflow-visible" style={{ left, top }}>
      <div className="p-1">
        <button onClick={onGoDetails} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors">
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /> Go to Details
        </button>
        <button onClick={onEdit} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors">
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" /> Rename / Edit
        </button>
        <div className="my-1 h-px bg-border" />

        {/* Move to folder */}
        <div className="relative">
          <button
            onMouseEnter={() => onSetSub('folder')}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${sub === 'folder' ? 'bg-accent' : 'hover:bg-accent'}`}
          >
            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 text-left">Move to</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {sub === 'folder' && (
            <div className="absolute left-full top-0 ml-1 w-52 rounded-xl border bg-card shadow-xl z-10">
              <div className="p-1">
                <button onClick={() => onMoveFolder(null)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors ${!project.folderId ? 'text-primary font-medium' : ''}`}>
                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" /> No folder
                  {!project.folderId && <span className="ml-auto text-primary text-xs">✓</span>}
                </button>
                {folders.map((f) => (
                  <button key={f.id} onClick={() => onMoveFolder(f.id)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors ${project.folderId === f.id ? 'text-primary font-medium' : ''}`}>
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: f.color }} />
                    {f.name}
                    {project.folderId === f.id && <span className="ml-auto text-primary text-xs">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Add tag */}
        <div className="relative">
          <button
            onMouseEnter={() => onSetSub('tag')}
            className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${sub === 'tag' ? 'bg-accent' : 'hover:bg-accent'}`}
          >
            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 text-left">Add tag</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {sub === 'tag' && tags.length > 0 && (
            <div className="absolute left-full top-0 ml-1 w-52 rounded-xl border bg-card shadow-xl z-10">
              <div className="p-1">
                {tags.map((tag) => (
                  <button key={tag.id} onClick={() => onToggleTag(tag.id)} className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors ${projectTagIds.includes(tag.id) ? 'font-medium' : ''}`}>
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: tag.color }} />
                    <span style={{ color: projectTagIds.includes(tag.id) ? tag.color : undefined }}>{tag.name}</span>
                    {projectTagIds.includes(tag.id) && <span className="ml-auto text-xs" style={{ color: tag.color }}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Move to team */}
        {otherTeams.length > 0 && (
          <div className="relative">
            <button
              onMouseEnter={() => onSetSub('team')}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${sub === 'team' ? 'bg-accent' : 'hover:bg-accent'}`}
            >
              <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 text-left">Move to team</span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
            {sub === 'team' && (
              <div className="absolute left-full top-0 ml-1 w-52 rounded-xl border bg-card shadow-xl z-10">
                <div className="p-1">
                  {otherTeams.map((team) => (
                    <button
                      key={team.id}
                      onClick={() => onMoveTeam(team)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent transition-colors"
                    >
                      <span className="h-6 w-6 rounded-full bg-brand-gradient flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                        {team.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="truncate">{team.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="my-1 h-px bg-border" />
        <button onClick={onDelete} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition-colors">
          <Trash2 className="h-3.5 w-3.5" /> Delete Project
        </button>
      </div>
    </div>
  );
});

// ── EmptyState ────────────────────────────────────────────────────────────────
function EmptyState({ onNew, hasFilters }: { onNew: () => void; hasFilters: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="h-14 w-14 rounded-2xl bg-brand-gradient flex items-center justify-center mb-4 shadow-md">
        <Database className="h-7 w-7 text-white" />
      </div>
      <h3 className="text-lg font-semibold mb-1">{hasFilters ? 'No matching projects' : 'No projects yet'}</h3>
      <p className="text-sm text-muted-foreground mb-6 max-w-xs">
        {hasFilters ? 'Try adjusting your filters.' : 'Create your first project to get started.'}
      </p>
      {!hasFilters && (
        <Button onClick={onNew} className="bg-brand-gradient text-white border-0 hover:opacity-90">
          <Plus className="mr-1.5 h-4 w-4" /> New Project
        </Button>
      )}
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function Modal({
  title,
  children,
  onClose,
  size = 'sm',
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  /** `md` fits folder/tag color rows without horizontal scroll */
  size?: 'sm' | 'md';
}) {
  const maxW = size === 'md' ? 'max-w-md' : 'max-w-sm';
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/25" onClick={onClose} />
      <div className={`fixed left-1/2 top-1/2 z-[51] -translate-x-1/2 -translate-y-1/2 w-full ${maxW} rounded-xl border bg-card p-5 shadow-xl`}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-base">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-accent transition-colors">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

// ── ColorPicker ───────────────────────────────────────────────────────────────
function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const isCustom = !COLORS.includes(value);
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Color</p>
      <div className="flex flex-nowrap items-center gap-2">
        {COLORS.map((c) => (
          <button key={c} type="button" onClick={() => onChange(c)}
            className={`h-6 w-6 shrink-0 rounded-full transition-transform hover:scale-110 ${value === c ? 'ring-2 ring-offset-2 ring-primary scale-110' : ''}`}
            style={{ background: c }}
          />
        ))}
        <label
          className={`relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-muted-foreground/40 transition-transform hover:scale-110 hover:border-primary/60 ${isCustom ? 'ring-2 ring-offset-2 ring-primary scale-110' : ''}`}
          style={isCustom ? { background: value } : {}}
          title="Custom color"
        >
          {!isCustom && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-muted-foreground">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 rounded-full border shrink-0" style={{ background: value }} />
        <span className="text-xs font-mono text-muted-foreground">{value}</span>
      </div>
    </div>
  );
}
