'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { EntityDefinitionInfo, DataEngineDoc, DataEnginePage } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ScrollText,
  Trash2,
} from 'lucide-react';

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

// ── Entity Documents Panel ──────────────────────────────────

export function EntityDocumentsPanel({ projectId, entityName }: { projectId: string; entityName: string }) {
  const [entity, setEntity] = useState<EntityDefinitionInfo | null>(null);
  const [docs, setDocs] = useState<DataEnginePage | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [insertOpen, setInsertOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<DataEngineDoc | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');

  const LIMIT = 50;

  // Reset state when the target entity (or project) changes — render-phase reset
  // so the document load effect below runs once with fresh state.
  const entityKey = `${projectId}/${entityName}`;
  const [prevEntityKey, setPrevEntityKey] = useState(entityKey);
  if (entityKey !== prevEntityKey) {
    setPrevEntityKey(entityKey);
    setEntity(null);
    setDocs(null);
    setPage(0);
    setFilterText('');
    setAppliedFilter('');
    setExpandedDoc(null);
    setEditDoc(null);
    setEditOpen(false);
    setInsertOpen(false);
  }

  // Debounce filter
  useEffect(() => {
    const h = setTimeout(() => setAppliedFilter(filterText.trim()), 350);
    return () => clearTimeout(h);
  }, [filterText]);

  // Load entity definition (for display name / badges / description)
  useEffect(() => {
    let cancelled = false;
    api.projects
      .getEntityDefinition(projectId, entityName)
      .then((info) => { if (!cancelled) setEntity(info); })
      .catch(() => { /* header falls back to the logical name */ });
    return () => { cancelled = true; };
  }, [projectId, entityName]);

  // Load documents
  useEffect(() => {
    loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, entityName, page, appliedFilter]);

  async function loadDocuments() {
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
      const result = await api.projects.dataEngineDocuments(projectId, entityName, {
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
    try {
      await api.projects.deleteDataEngineDocument(projectId, entityName, docId);
      toast.success('Document deleted');
      loadDocuments();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  const totalPages = docs ? Math.max(1, Math.ceil(docs.total / LIMIT)) : 1;
  const currentPage = page + 1;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      {/* Entity header */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{entity?.displayName ?? entityName}</h2>
            {entity && (
              <>
                <Badge variant="outline" className="text-[10px]">v{entity.schemaVersion}</Badge>
                <Badge variant="secondary" className="text-[10px]">{entity.storageStrategy}</Badge>
              </>
            )}
          </div>
          {entity?.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{entity.description}</p>
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

      {/* Dialogs */}
      <InsertDocDialog open={insertOpen} onOpenChange={setInsertOpen} projectId={projectId} entityName={entityName} onInserted={loadDocuments} />
      <EditDocDialog open={editOpen} onOpenChange={setEditOpen} projectId={projectId} entityName={entityName} doc={editDoc} onSaved={loadDocuments} />
    </div>
  );
}
