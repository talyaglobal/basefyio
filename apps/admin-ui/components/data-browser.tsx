'use client';

import { useEffect, useState, useRef } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { EntityDefinitionInfo, DataEngineDoc, DataEnginePage } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
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
  Database,
  ScrollText,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface DataBrowserProps {
  projectId: string;
}

// ── Create Entity Dialog ────────────────────────────────────

function CreateEntityDialog({
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
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error('Entity name is required'); return; }
    if (!displayName.trim()) { toast.error('Display name is required'); return; }
    setSaving(true);
    try {
      await api.projects.createEntityDefinition(projectId, {
        logicalName: name.trim(),
        displayName: displayName.trim(),
        fields: [],
        description: description.trim() || undefined,
      });
      toast.success(`Entity "${displayName}" created`);
      setName(''); setDisplayName(''); setDescription('');
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
          <DialogTitle>Create Entity</DialogTitle>
          <DialogDescription>Define a new entity type for your application data.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Logical name</Label>
            <Input placeholder="e.g. patients, orders, tasks" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div>
            <Label>Display name</Label>
            <Input placeholder="e.g. Patients, Orders, Tasks" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input placeholder="What this entity stores" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Creating...' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Insert Document Dialog ──────────────────────────────────

function InsertDocDialog({
  open,
  onOpenChange,
  projectId,
  entityName,
  onInserted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  entityName: string;
  onInserted: () => void;
}) {
  const [json, setJson] = useState('{\n  \n}');
  const [saving, setSaving] = useState(false);

  function prettifyJson() {
    try {
      const parsed = JSON.parse(json);
      setJson(JSON.stringify(parsed, null, 2));
    } catch { /* not valid yet */ }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(json); } catch { toast.error('Invalid JSON'); return; }
    setSaving(true);
    try {
      await api.projects.insertDataEngineDocument(projectId, entityName, parsed);
      toast.success('Document inserted');
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
          <DialogDescription>Insert a JSON document into <strong>{entityName}</strong>.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <textarea
            className="w-full h-64 rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            onBlur={prettifyJson}
            onPaste={(e) => {
              const pasted = e.clipboardData.getData('text');
              try {
                const parsed = JSON.parse(pasted);
                e.preventDefault();
                setJson(JSON.stringify(parsed, null, 2));
              } catch { /* not valid JSON, let default paste happen */ }
            }}
            spellCheck={false}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Inserting...' : 'Insert'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Document Dialog ────────────────────────────────────

function EditDocDialog({
  open,
  onOpenChange,
  projectId,
  entityName,
  doc,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  entityName: string;
  doc: DataEngineDoc | null;
  onSaved: () => void;
}) {
  const [json, setJson] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!doc) return;
    const { _id, _entity, _projectId, _schemaVersion, _version, _eventSequence, _status, _createdAt, _updatedAt, _createdBy, _deletedAt, ...userData } = doc;
    setJson(JSON.stringify(userData, null, 2));
  }, [doc]);

  function prettifyJson() {
    try {
      const parsed = JSON.parse(json);
      setJson(JSON.stringify(parsed, null, 2));
    } catch { /* not valid yet */ }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!doc) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(json); } catch { toast.error('Invalid JSON'); return; }
    setSaving(true);
    try {
      await api.projects.updateDataEngineDocument(projectId, entityName, doc._id, parsed);
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
            Editing <code className="text-xs bg-muted px-1 rounded">{doc?._id}</code>
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
              try {
                const parsed = JSON.parse(pasted);
                e.preventDefault();
                setJson(JSON.stringify(parsed, null, 2));
              } catch { /* not valid JSON, let default paste happen */ }
            }}
            spellCheck={false}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Data Browser ───────────────────────────────────────

export function DataBrowser({ projectId }: DataBrowserProps) {
  const [entities, setEntities] = useState<EntityDefinitionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [docs, setDocs] = useState<DataEnginePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<DataEngineDoc | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [entitySearch, setEntitySearch] = useState('');
  const [filterText, setFilterText] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');

  const LIMIT = 50;

  // Sidebar resize
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('basefyio_data_sidebar_width');
      if (saved) return Math.max(160, Math.min(480, Number(saved)));
    }
    return 240;
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
      setSidebarWidth(Math.max(160, Math.min(480, resizeStartWidth.current + ev.clientX - resizeStartX.current)));
    }
    function onMouseUp() {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      setSidebarWidth((w) => { localStorage.setItem('basefyio_data_sidebar_width', String(w)); return w; });
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  // Debounce filter
  useEffect(() => {
    const h = setTimeout(() => setAppliedFilter(filterText.trim()), 350);
    return () => clearTimeout(h);
  }, [filterText]);

  const searchLower = entitySearch.trim().toLowerCase();
  const filteredEntities = searchLower
    ? entities.filter((e) => e.logicalName.toLowerCase().includes(searchLower) || e.displayName.toLowerCase().includes(searchLower))
    : entities;

  // Load entities
  useEffect(() => { loadEntities(); }, [projectId]);

  async function loadEntities() {
    setLoading(true);
    try {
      const result = await api.projects.listEntityDefinitions(projectId);
      setEntities(result);
      if (result.length > 0 && !selected) selectEntity(result[0].logicalName);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }

  function selectEntity(name: string) {
    setSelected(name);
    setPage(0);
    setFilterText('');
    setAppliedFilter('');
    setExpandedDoc(null);
  }

  // Load documents
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
        try { filter = JSON.parse(appliedFilter); } catch {
          toast.error('Filter must be valid JSON');
          setDataLoading(false);
          return;
        }
      }
      const result = await api.projects.dataEngineDocuments(projectId, selected, {
        filter,
        limit: LIMIT,
        offset: page * LIMIT,
      });
      setDocs(result);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setDataLoading(false);
    }
  }

  async function handleDeleteDoc(docId: string) {
    if (!selected) return;
    try {
      await api.projects.deleteDataEngineDocument(projectId, selected, docId);
      toast.success('Document deleted');
      loadDocuments();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  const totalPages = docs ? Math.max(1, Math.ceil(docs.total / LIMIT)) : 1;
  const currentPage = page + 1;
  const selectedEntity = entities.find((e) => e.logicalName === selected);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <div className="flex flex-col border-r bg-card" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold text-foreground">Entities</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-2 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-8 pl-7 text-xs" placeholder="Search entities..." value={entitySearch} onChange={(e) => setEntitySearch(e.target.value)} />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-1">
          {filteredEntities.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              {entities.length === 0 ? 'No entities yet. Click + to create one.' : 'No matching entities.'}
            </div>
          ) : (
            filteredEntities.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => selectEntity(e.logicalName)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  selected === e.logicalName
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <ScrollText className="h-3.5 w-3.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="truncate block">{e.displayName}</span>
                  <span className="text-[10px] text-muted-foreground truncate block">{e.logicalName}</span>
                </div>
                {e.generatedByAI && (
                  <Badge variant="secondary" className="h-4 px-1 text-[8px]">AI</Badge>
                )}
              </button>
            ))
          )}
        </div>

        {/* Engine label */}
        <div className="border-t px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Database className="h-3 w-3" />
            <span>Basefyio Data Engine</span>
          </div>
        </div>
      </div>

      {/* Resize handle */}
      <div className="w-1 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors" onMouseDown={handleResizeMouseDown} />

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
            <ScrollText className="h-12 w-12" />
            <p className="text-sm">
              {entities.length === 0 ? 'Create your first entity to start storing application data.' : 'Select an entity from the sidebar.'}
            </p>
            {entities.length === 0 && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Create Entity
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Entity header */}
            <div className="flex items-center gap-3 border-b px-4 py-2">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">{selectedEntity?.displayName}</h2>
                  <Badge variant="outline" className="text-[10px]">v{selectedEntity?.schemaVersion}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{selectedEntity?.storageStrategy}</Badge>
                </div>
                {selectedEntity?.description && (
                  <p className="text-xs text-muted-foreground mt-0.5">{selectedEntity.description}</p>
                )}
              </div>
            </div>

            {/* Toolbar */}
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-8 pl-8 text-xs font-mono"
                  placeholder='Filter JSON, e.g. {"status":"active"}'
                  value={filterText}
                  onChange={(e) => { setFilterText(e.target.value); setPage(0); }}
                />
              </div>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setInsertOpen(true)}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Insert
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadDocuments} title="Refresh">
                <RefreshCw className={cn('h-3.5 w-3.5', dataLoading && 'animate-spin')} />
              </Button>
            </div>

            {/* Pagination header */}
            <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
              <span className="text-xs text-muted-foreground">{docs?.total ?? 0} document(s)</span>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Page {currentPage} of {totalPages}</span>
                <Button variant="ghost" size="icon" className="h-6 w-6" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-6 w-6" disabled={currentPage >= totalPages} onClick={() => setPage((p) => p + 1)}>
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
                  <ScrollText className="h-8 w-8" />
                  <p className="text-sm">{appliedFilter ? 'No documents match this filter.' : 'This entity has no documents.'}</p>
                  {!appliedFilter && (
                    <Button variant="outline" size="sm" onClick={() => setInsertOpen(true)}>
                      <Plus className="mr-1 h-3.5 w-3.5" /> Insert Document
                    </Button>
                  )}
                </div>
              ) : (
                <div className="divide-y">
                  {docs.data.map((doc) => {
                    const isExpanded = expandedDoc === doc._id;
                    const { _id, _entity, _projectId, _schemaVersion, _version, _eventSequence, _status, _createdAt, _updatedAt, _createdBy, _deletedAt, ...userData } = doc;
                    const preview = JSON.stringify(userData);
                    const full = JSON.stringify(userData, null, 2);

                    return (
                      <div key={doc._id} className="group transition-colors hover:bg-muted/30">
                        <div className="flex items-start gap-2 px-4 py-2">
                          <div
                            className="flex-1 min-w-0 cursor-pointer"
                            onClick={() => setExpandedDoc(isExpanded ? null : doc._id)}
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <code className="text-[10px] text-muted-foreground font-mono">{doc._id}</code>
                              <Badge variant={doc._status === 'active' ? 'default' : 'secondary'} className="h-4 px-1 text-[8px]">
                                {doc._status}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground">v{doc._version}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {new Date(doc._createdAt).toLocaleString()}
                              </span>
                            </div>
                            {isExpanded ? (
                              <pre className="mt-2 text-xs font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-3 max-h-96 overflow-y-auto">
                                {full}
                              </pre>
                            ) : (
                              <p className="mt-0.5 text-xs text-muted-foreground truncate font-mono max-w-[600px]">
                                {preview.length > 200 ? preview.slice(0, 200) + '...' : preview}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="Copy ID"
                              onClick={() => { navigator.clipboard.writeText(doc._id); toast.success('ID copied'); }}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit"
                              onClick={() => { setEditDoc(doc); setEditOpen(true); }}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="Delete"
                              onClick={() => handleDeleteDoc(doc._id)}>
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

      {/* Dialogs */}
      <CreateEntityDialog open={createOpen} onOpenChange={setCreateOpen} projectId={projectId} onCreated={loadEntities} />
      {selected && (
        <>
          <InsertDocDialog open={insertOpen} onOpenChange={setInsertOpen} projectId={projectId} entityName={selected} onInserted={loadDocuments} />
          <EditDocDialog open={editOpen} onOpenChange={setEditOpen} projectId={projectId} entityName={selected} doc={editDoc} onSaved={loadDocuments} />
        </>
      )}
    </div>
  );
}
