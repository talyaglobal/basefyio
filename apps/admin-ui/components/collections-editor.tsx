'use client';

import { useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import type { CollectionInfo, DocumentRecord, DocumentListResult } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn, formatCount } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Layers,
  MoreVertical,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface CollectionsEditorProps {
  projectId: string;
  /** Collection to select on first load (e.g. from ?open= deep links). */
  initialCollection?: string | null;
}

// ── Create Collection Dialog ────────────────────────────────

function CreateCollectionDialog({
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Collection name is required');
      return;
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
      toast.error('Collection name must start with a letter or underscore and contain only alphanumeric characters');
      return;
    }
    setSaving(true);
    try {
      await api.projects.createCollection(projectId, trimmed);
      toast.success(`Collection "${trimmed}" created`);
      setName('');
      onOpenChange(false);
      onCreated();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Collection</DialogTitle>
          <DialogDescription>
            A collection stores schema-less JSON documents. You can insert documents with any structure.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="coll-name">Collection name</Label>
            <Input
              id="coll-name"
              placeholder="e.g. posts, products, events"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Insert Document Dialog ──────────────────────────────────

function InsertDocumentDialog({
  open,
  onOpenChange,
  projectId,
  collectionName,
  onInserted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  collectionName: string;
  onInserted: () => void;
}) {
  const [json, setJson] = useState('{\n  \n}');
  const [saving, setSaving] = useState(false);

  function prettifyJson() {
    try { setJson(JSON.stringify(JSON.parse(json), null, 2)); } catch { /* not valid yet */ }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let parsed: Record<string, unknown> | Record<string, unknown>[];
    try {
      parsed = JSON.parse(json);
    } catch {
      toast.error('Invalid JSON');
      return;
    }
    setSaving(true);
    try {
      await api.projects.insertDocument(projectId, collectionName, parsed);
      const count = Array.isArray(parsed) ? parsed.length : 1;
      toast.success(`${count} document(s) inserted`);
      setJson('{\n  \n}');
      onOpenChange(false);
      onInserted();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Insert Document</DialogTitle>
          <DialogDescription>
            Paste a JSON object or an array of objects to insert into <strong>{collectionName}</strong>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <textarea
            className="w-full h-64 rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            onBlur={prettifyJson}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              try { e.preventDefault(); setJson(JSON.stringify(JSON.parse(pasted), null, 2)); } catch { /* let default paste */ }
            }}
            spellCheck={false}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Inserting...' : 'Insert'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Document Dialog ────────────────────────────────────

function EditDocumentDialog({
  open,
  onOpenChange,
  projectId,
  collectionName,
  doc,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  collectionName: string;
  doc: DocumentRecord | null;
  onSaved: () => void;
}) {
  const [json, setJson] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (doc) setJson(JSON.stringify(doc.data, null, 2));
  }, [doc]);

  function prettifyJson() {
    try { setJson(JSON.stringify(JSON.parse(json), null, 2)); } catch { /* not valid yet */ }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!doc) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json);
    } catch {
      toast.error('Invalid JSON');
      return;
    }
    setSaving(true);
    try {
      await api.projects.replaceDocument(projectId, collectionName, doc.id, parsed);
      toast.success('Document saved');
      onOpenChange(false);
      onSaved();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit Document</DialogTitle>
          <DialogDescription>
            Editing document <code className="text-xs bg-muted px-1 rounded">{doc?.id}</code>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <textarea
            className="w-full h-72 rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            onBlur={prettifyJson}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              try { e.preventDefault(); setJson(JSON.stringify(JSON.parse(pasted), null, 2)); } catch { /* let default paste */ }
            }}
            spellCheck={false}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Collections Editor ─────────────────────────────────

export function CollectionsEditor({ projectId, initialCollection = null }: CollectionsEditorProps) {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  // Deep-link target is consumed once so later refreshes restore normally.
  const pendingInitialRef = useRef<string | null>(initialCollection);
  const [selected, setSelected] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [docs, setDocs] = useState<DocumentListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [page, setPage] = useState(0); // offset-based
  const [createOpen, setCreateOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<DocumentRecord | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());

  const [filterText, setFilterText] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [collectionSearch, setCollectionSearch] = useState('');

  const LIMIT = 50;

  // ── Sidebar resize ────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('basefyio_collections_sidebar_width');
      if (saved) return Math.max(160, Math.min(480, Number(saved)));
    }
    return 224;
  });
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  function handleResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;

    function onMouseMove(ev: MouseEvent) {
      if (!isResizing.current) return;
      const delta = ev.clientX - resizeStartX.current;
      const next = Math.max(160, Math.min(480, resizeStartWidth.current + delta));
      setSidebarWidth(next);
    }

    function onMouseUp() {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      setSidebarWidth((w) => {
        localStorage.setItem('basefyio_collections_sidebar_width', String(w));
        return w;
      });
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Debounce filter
  useEffect(() => {
    const handle = setTimeout(() => setAppliedFilter(filterText.trim()), 350);
    return () => clearTimeout(handle);
  }, [filterText]);

  const stateStorageKey = `basefyio_collections_state_${projectId}`;

  const collectionSearchLower = collectionSearch.trim().toLowerCase();
  const filteredCollections =
    collectionSearchLower.length === 0
      ? collections
      : collections.filter((c) => c.name.toLowerCase().includes(collectionSearchLower));

  // ── Load collections ────────────────────────────────────
  useEffect(() => {
    loadCollections();
  }, [projectId]);

  // Persist state
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!selected && openTabs.length === 0) return;
    try {
      localStorage.setItem(stateStorageKey, JSON.stringify({ selected, openTabs }));
    } catch {}
  }, [selected, openTabs, stateStorageKey]);

  async function loadCollections() {
    setLoading(true);
    try {
      const result = await api.projects.listCollections(projectId);
      setCollections(result);

      // Restore state
      let restoredSelected: string | null = null;
      let restoredTabs: string[] = [];
      if (typeof window !== 'undefined') {
        try {
          const raw = localStorage.getItem(stateStorageKey);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed.openTabs)) {
              restoredTabs = parsed.openTabs.filter((name: string) =>
                result.some((c) => c.name === name),
              );
            }
            if (typeof parsed.selected === 'string' && result.some((c) => c.name === parsed.selected)) {
              restoredSelected = parsed.selected;
            }
          }
        } catch {}
      }

      if (restoredTabs.length > 0) setOpenTabs(restoredTabs);
      else setOpenTabs((prev) => prev.filter((name) => result.some((c) => c.name === name)));

      const deepLinked =
        pendingInitialRef.current && result.some((c) => c.name === pendingInitialRef.current)
          ? pendingInitialRef.current
          : null;
      pendingInitialRef.current = null;

      if (result.length > 0) {
        const target =
          deepLinked ??
          restoredSelected ??
          (selected && result.some((c) => c.name === selected) ? selected : result[0].name);
        openCollection(target);
      } else {
        setSelected(null);
        setOpenTabs([]);
        setDocs(null);
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  function openCollection(name: string) {
    setSelected(name);
    setOpenTabs((tabs) => (tabs.includes(name) ? tabs : [...tabs, name]));
    setPage(0);
    setFilterText('');
    setAppliedFilter('');
    setSelectedDocs(new Set());
    setExpandedDoc(null);
  }

  // ── Load documents ────────────────────────────────────
  useEffect(() => {
    if (!selected) return;
    loadDocuments();
  }, [selected, page, appliedFilter]);

  async function loadDocuments() {
    if (!selected) return;
    setDataLoading(true);
    try {
      let filter: Record<string, unknown> | undefined;
      if (appliedFilter) {
        try {
          filter = JSON.parse(appliedFilter);
        } catch {
          // treat as text search across data field
          // simple containment search not possible without knowing fields
          // Just try as raw JSON filter
          toast.error('Filter must be valid JSON, e.g. {"status": "active"}');
          setDataLoading(false);
          return;
        }
      }
      const result = await api.projects.collectionDocuments(projectId, selected, {
        filter,
        limit: LIMIT,
        offset: page * LIMIT,
      });
      setDocs(result);
      setSelectedDocs(new Set());
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDataLoading(false);
    }
  }

  async function handleDropCollection(name: string) {
    if (!(await confirmDialog({ title: 'Drop collection', description: `Are you sure you want to drop collection "${name}"? All documents will be permanently deleted.`, confirmText: 'Drop collection', destructive: true }))) return;
    try {
      await api.projects.dropCollection(projectId, name);
      toast.success(`Collection "${name}" dropped`);
      loadCollections();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDeleteDoc(docId: string) {
    if (!selected) return;
    try {
      await api.projects.deleteDocument(projectId, selected, docId);
      toast.success('Document deleted');
      loadDocuments();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleBulkDelete() {
    if (!selected || selectedDocs.size === 0) return;
    if (!(await confirmDialog({ title: 'Delete documents', description: `Delete ${selectedDocs.size} selected document(s)?`, destructive: true }))) return;
    try {
      const filter = { id: { $in: Array.from(selectedDocs) } };
      // bulk delete by iterating individual deletes (the bulk endpoint uses data filters, not id)
      for (const docId of selectedDocs) {
        await api.projects.deleteDocument(projectId, selected, docId);
      }
      toast.success(`${selectedDocs.size} document(s) deleted`);
      setSelectedDocs(new Set());
      loadDocuments();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  function closeTab(name: string) {
    const newTabs = openTabs.filter((t) => t !== name);
    setOpenTabs(newTabs);
    if (selected === name) {
      if (newTabs.length > 0) {
        openCollection(newTabs[newTabs.length - 1]);
      } else {
        setSelected(null);
        setDocs(null);
      }
    }
  }

  function toggleDocSelection(docId: string) {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!docs) return;
    if (selectedDocs.size === docs.data.length) {
      setSelectedDocs(new Set());
    } else {
      setSelectedDocs(new Set(docs.data.map((d) => d.id)));
    }
  }

  const totalPages = docs ? Math.max(1, Math.ceil(docs.total / LIMIT)) : 1;
  const currentPage = page + 1;

  // ── Render ────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Sidebar ── */}
      <div
        className="flex flex-col border-r bg-card"
        style={{ width: sidebarWidth, minWidth: sidebarWidth }}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold text-foreground">Collections</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-2 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-7 text-xs"
              placeholder="Search collections..."
              value={collectionSearch}
              onChange={(e) => setCollectionSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-1">
          {filteredCollections.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {collections.length === 0
                ? 'No collections yet. Click + to create one.'
                : 'No matching collections.'}
            </div>
          ) : (
            filteredCollections.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => openCollection(c.name)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  selected === c.name
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Layers className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate flex-1">{c.name}</span>
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {formatCount(c.documentCount)}
                </Badge>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Resize handle ── */}
      <div
        className="w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
        onMouseDown={handleResizeMouseDown}
      />

      {/* ── Main area ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Tab strip */}
        {openTabs.length > 0 && (
          <div className="flex items-center gap-0.5 border-b bg-muted/30 px-2 py-1 overflow-x-auto">
            {openTabs.map((tab) => (
              <div
                key={tab}
                className={cn(
                  'group flex items-center gap-1 rounded-md px-2.5 py-1 text-xs cursor-pointer transition-colors',
                  selected === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-background/50',
                )}
                onClick={() => openCollection(tab)}
              >
                <Layers className="h-3 w-3" />
                <span>{tab}</span>
                <button
                  type="button"
                  className="ml-1 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Content */}
        {!selected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
            <Layers className="h-12 w-12" />
            <p className="text-sm">
              {collections.length === 0
                ? 'Create your first collection to start storing documents.'
                : 'Select a collection from the sidebar.'}
            </p>
            {collections.length === 0 && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Create Collection
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-xs font-mono"
                  placeholder='Filter JSON, e.g. {"status":"active"}'
                  value={filterText}
                  onChange={(e) => {
                    setFilterText(e.target.value);
                    setPage(0);
                  }}
                />
              </div>

              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setInsertOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Insert
              </Button>

              {selectedDocs.size > 0 && (
                <Button variant="destructive" size="sm" className="h-8 text-xs" onClick={handleBulkDelete}>
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete ({selectedDocs.size})
                </Button>
              )}

              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadDocuments} title="Refresh">
                <RefreshCw className={cn('h-3.5 w-3.5', dataLoading && 'animate-spin')} />
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => handleDropCollection(selected)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Drop Collection
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Header */}
            <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{selected}</span>
                <span>{docs?.total ?? 0} document(s)</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {/* Document list */}
            <div className="flex-1 overflow-y-auto">
              {dataLoading && !docs ? (
                <div className="flex items-center justify-center py-16">
                  <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                </div>
              ) : !docs || docs.data.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground">
                  <Layers className="h-8 w-8" />
                  <p className="text-sm">
                    {appliedFilter ? 'No documents match this filter.' : 'This collection is empty.'}
                  </p>
                  {!appliedFilter && (
                    <Button variant="outline" size="sm" onClick={() => setInsertOpen(true)}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> Insert Document
                    </Button>
                  )}
                </div>
              ) : (
                <div className="divide-y">
                  {/* Select all */}
                  <div className="flex items-center gap-2 px-4 py-1 bg-muted/10 border-b">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-muted-foreground"
                      checked={docs.data.length > 0 && selectedDocs.size === docs.data.length}
                      onChange={toggleSelectAll}
                    />
                    <span className="text-[10px] text-muted-foreground">Select all</span>
                  </div>

                  {docs.data.map((doc) => {
                    const isExpanded = expandedDoc === doc.id;
                    const dataStr = JSON.stringify(doc.data, null, 2);
                    const preview = JSON.stringify(doc.data);
                    const isSelected = selectedDocs.has(doc.id);

                    return (
                      <div
                        key={doc.id}
                        className={cn(
                          'group transition-colors',
                          isSelected && 'bg-primary/5',
                        )}
                      >
                        <div className="flex items-start gap-2 px-4 py-2">
                          <input
                            type="checkbox"
                            className="mt-1 h-3.5 w-3.5 rounded border-muted-foreground"
                            checked={isSelected}
                            onChange={() => toggleDocSelection(doc.id)}
                          />
                          <div
                            className="flex-1 min-w-0 cursor-pointer"
                            onClick={() => setExpandedDoc(isExpanded ? null : doc.id)}
                          >
                            <div className="flex items-center gap-2">
                              <code className="text-[10px] text-muted-foreground font-mono">{doc.id}</code>
                              <span className="text-[10px] text-muted-foreground">
                                {new Date(doc.created_at).toLocaleString()}
                              </span>
                            </div>
                            {isExpanded ? (
                              <pre className="mt-2 text-xs font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-3 max-h-96 overflow-y-auto">
                                {dataStr}
                              </pre>
                            ) : (
                              <p className="mt-0.5 text-xs text-muted-foreground truncate font-mono max-w-[600px]">
                                {preview.length > 200 ? preview.slice(0, 200) + '...' : preview}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Copy ID"
                              onClick={() => {
                                navigator.clipboard.writeText(doc.id);
                                toast.success('ID copied');
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              title="Edit"
                              onClick={() => {
                                setEditDoc(doc);
                                setEditOpen(true);
                              }}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              title="Delete"
                              onClick={() => handleDeleteDoc(doc.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Dialogs ── */}
      <CreateCollectionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        onCreated={loadCollections}
      />

      {selected && (
        <>
          <InsertDocumentDialog
            open={insertOpen}
            onOpenChange={setInsertOpen}
            projectId={projectId}
            collectionName={selected}
            onInserted={loadDocuments}
          />
          <EditDocumentDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            projectId={projectId}
            collectionName={selected}
            doc={editDoc}
            onSaved={loadDocuments}
          />
        </>
      )}
    </div>
  );
}
