'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { EntityDefinitionInfo, DataEngineDoc, DataEnginePage } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
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
  EntityFieldsEditor,
  FieldsEditorValue,
  initialFieldsValue,
  resolveFields,
} from '@/components/entity-fields-editor';
import { chunk, downloadJson, readJsonDocuments, withoutEnvelope } from '@/lib/json-transfer';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ScrollText,
  Settings2,
  Trash2,
  Upload,
} from 'lucide-react';

/** Parse a JSON object typed by the user; returns an error message instead of throwing. */
function parseJsonObject(text: string): { value?: Record<string, unknown>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: any) {
    return { error: `Invalid JSON: ${err?.message ?? 'cannot parse'}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'A document must be a JSON object, e.g. {"name": "value"}' };
  }
  return { value: parsed as Record<string, unknown> };
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
    const { value, error } = parseJsonObject(json);
    if (!value) { toast.error(error); return; }
    setSaving(true);
    try {
      await api.projects.insertDataEngineDocument(projectId, entityName, value);
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
          <DialogDescription>
            Insert a JSON document into <strong>{entityName}</strong>. It is checked against the entity&apos;s fields.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <textarea
            className="w-full h-64 rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            aria-label="Document JSON"
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

/**
 * Saves the whole document (a replacement), so fields removed in the editor
 * are removed from the document. The save carries the version that was
 * opened (If-Match): if someone changed the document meanwhile, it fails
 * instead of overwriting their change.
 */
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
    setJson(JSON.stringify(withoutEnvelope(doc), null, 2));
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
    const { value, error } = parseJsonObject(json);
    if (!value) { toast.error(error); return; }
    setSaving(true);
    try {
      await api.projects.replaceDataEngineDocument(projectId, entityName, doc._id, value, doc._version);
      toast.success('Document saved');
      onOpenChange(false);
      onSaved();
    } catch (err: any) {
      if (err?.status === 409) {
        toast.error('This document was changed by someone else after you opened it. Close the editor and reload to see the latest version.');
      } else {
        toast.error(err.message);
      }
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
            Editing <code className="text-xs bg-muted px-1 rounded">{doc?._id}</code> (version {doc?._version}).
            Saving replaces the document — fields you remove here are removed.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <textarea
            className="w-full h-72 rounded-md border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            aria-label="Document JSON"
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

// ── Edit Entity Dialog ──────────────────────────────────────

function EditEntityDialog({
  open,
  onOpenChange,
  projectId,
  entity,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  entity: EntityDefinitionInfo | null;
  onSaved: (updated: EntityDefinitionInfo) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<FieldsEditorValue>(() => initialFieldsValue([]));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!entity || !open) return;
    setDisplayName(entity.displayName);
    setDescription(entity.description ?? '');
    setFields(initialFieldsValue(Array.isArray(entity.fields) ? entity.fields : []));
  }, [entity, open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!entity) return;
    if (!displayName.trim()) { toast.error('Display name is required'); return; }
    let fieldList: unknown[];
    try {
      fieldList = resolveFields(fields);
    } catch (err: any) {
      toast.error(err.message);
      return;
    }
    setSaving(true);
    try {
      const updated = await api.projects.updateEntityDefinition(projectId, entity.logicalName, {
        displayName: displayName.trim(),
        description: description.trim() || null,
        fields: fieldList,
      });
      toast.success(`Entity "${updated.displayName}" saved`);
      onOpenChange(false);
      onSaved(updated);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Entity</DialogTitle>
          <DialogDescription>
            Changing fields publishes a new schema version. Documents already stored stay
            readable; they are checked against the new fields the next time they are written.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label>Logical name</Label>
            <Input value={entity?.logicalName ?? ''} disabled />
          </div>
          <div>
            <Label htmlFor="ee-display">Display name</Label>
            <Input id="ee-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ee-desc">Description</Label>
            <Input id="ee-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <EntityFieldsEditor value={fields} onChange={setFields} />
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

export function EntityDocumentsPanel({
  projectId,
  entityName,
  onEntityChanged,
  onEntityDeleted,
}: {
  projectId: string;
  entityName: string;
  /** Called after documents or the definition change (the sidebar refreshes counts). */
  onEntityChanged?: () => void;
  /** Called after the entity itself was deleted. */
  onEntityDeleted?: () => void;
}) {
  const [entity, setEntity] = useState<EntityDefinitionInfo | null>(null);
  const [docs, setDocs] = useState<DataEnginePage | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [insertOpen, setInsertOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<DataEngineDoc | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [entityEditOpen, setEntityEditOpen] = useState(false);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [transferBusy, setTransferBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
    setFilterError(null);
    setShowDeleted(false);
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
  }, [projectId, entityName, page, appliedFilter, showDeleted]);

  async function loadDocuments() {
    setDataLoading(true);
    try {
      let filter: Record<string, unknown> | undefined;
      if (appliedFilter) {
        const parsed = parseJsonObject(appliedFilter);
        if (!parsed.value) {
          setFilterError(`Filter: ${parsed.error}. Example: {"status":"active"} or {"total":{"$gte":10}}`);
          setDataLoading(false);
          return;
        }
        filter = parsed.value;
      }
      const result = await api.projects.dataEngineDocuments(projectId, entityName, {
        filter,
        limit: LIMIT,
        offset: page * LIMIT,
        includeSoftDeleted: showDeleted,
      });
      setFilterError(null);
      setDocs(result);
    } catch (err: any) {
      if (err?.status === 400 && appliedFilter) {
        // Keep the last results; explain what is wrong with the filter inline.
        setFilterError(err.message);
      } else {
        toast.error(err.message);
      }
    } finally {
      setDataLoading(false);
    }
  }

  function changed() {
    loadDocuments();
    onEntityChanged?.();
  }

  async function handleDeleteDoc(docId: string) {
    const ok = await confirmDialog({
      title: 'Delete document',
      description: 'Delete this document? It is soft-deleted: turn on "Show deleted" to see it again and restore it.',
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.projects.deleteDataEngineDocument(projectId, entityName, docId);
      toast.success('Document deleted');
      changed();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleRestoreDoc(docId: string) {
    try {
      await api.projects.restoreDataEngineDocument(projectId, entityName, docId);
      toast.success('Document restored');
      changed();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleDeleteEntity() {
    const ok = await confirmDialog({
      title: 'Delete entity',
      description: `Delete the entity "${entityName}"? Its definition and schema history are removed.`,
      confirmText: 'Delete entity',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.projects.deleteEntityDefinition(projectId, entityName);
      toast.success(`Entity "${entityName}" deleted`);
      onEntityDeleted?.();
    } catch (err: any) {
      if (err?.status !== 409) {
        toast.error(err.message);
        return;
      }
      const typed = await promptDialog({
        title: 'Entity has documents',
        description: `${err.message} Type the entity name to delete it together with all of its documents. This cannot be undone.`,
        placeholder: entityName,
        confirmText: 'Delete permanently',
      });
      if (typed === null) return;
      if (typed.trim() !== entityName) {
        toast.error('The name did not match — nothing was deleted');
        return;
      }
      try {
        const result = await api.projects.deleteEntityDefinition(projectId, entityName, true);
        toast.success(`Entity "${entityName}" and ${result.documentsRemoved} document(s) deleted`);
        onEntityDeleted?.();
      } catch (e: any) {
        toast.error(e.message);
      }
    }
  }

  async function handleExport() {
    setTransferBusy('Exporting…');
    try {
      const all: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += 1000) {
        const result = await api.projects.dataEngineDocuments(projectId, entityName, { limit: 1000, offset });
        all.push(...result.data.map((d) => withoutEnvelope(d)));
        if (!result.hasMore || result.data.length === 0) break;
      }
      downloadJson(`${entityName}.json`, all);
      toast.success(`Exported ${all.length} document(s)`);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setTransferBusy(null);
    }
  }

  async function handleImport(file: File) {
    let documents: Record<string, unknown>[];
    try {
      documents = await readJsonDocuments(file);
    } catch (err: any) {
      toast.error(err.message);
      return;
    }
    if (documents.length === 0) { toast.error(`${file.name} contains no documents`); return; }
    setTransferBusy('Importing…');
    let imported = 0;
    try {
      // Each batch is validated as a whole before any of it is written.
      for (const batch of chunk(documents.map(withoutEnvelope), 1000)) {
        await api.projects.insertDataEngineDocuments(projectId, entityName, batch);
        imported += batch.length;
      }
      toast.success(`Imported ${imported} document(s)`);
    } catch (err: any) {
      toast.error(`${imported} of ${documents.length} imported; stopped at the next batch: ${err.message}`);
    } finally {
      setTransferBusy(null);
      changed();
    }
  }

  const totalPages = docs ? Math.max(1, Math.ceil(docs.total / LIMIT)) : 1;
  const currentPage = page + 1;
  const fieldCount = Array.isArray(entity?.fields) ? entity!.fields.length : 0;

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      {/* Entity header */}
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold">{entity?.displayName ?? entityName}</h2>
            {entity && (
              <>
                <Badge variant="outline" className="text-[10px]">schema v{entity.schemaVersion}</Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {fieldCount === 0 ? 'no fields (schema-free)' : `${fieldCount} field${fieldCount === 1 ? '' : 's'} validated`}
                </Badge>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {entity?.description ? `${entity.description} · ` : ''}
            Data Engine entity — API: /api/v1/projects/:id/data/{entityName}
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!entity} onClick={() => setEntityEditOpen(true)}>
          <Settings2 className="mr-1 h-3.5 w-3.5" /> Edit entity
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs text-destructive" onClick={handleDeleteEntity}>
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete entity
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className={cn('h-8 pl-8 text-xs font-mono', filterError && 'border-destructive')}
            placeholder='Filter, e.g. {"status":"active"} or {"total":{"$gte":10}}'
            aria-label="Filter documents (JSON)"
            aria-invalid={!!filterError}
            value={filterText}
            onChange={(e) => { setFilterText(e.target.value); setPage(0); }}
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => { setShowDeleted(e.target.checked); setPage(0); }}
          />
          Show deleted
        </label>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setInsertOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Insert
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!!transferBusy} onClick={() => fileInput.current?.click()}>
          <Upload className="mr-1 h-3.5 w-3.5" /> Import
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!!transferBusy} onClick={handleExport}>
          <Download className="mr-1 h-3.5 w-3.5" /> Export
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,.ndjson,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleImport(file);
          }}
        />
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadDocuments} title="Refresh" aria-label="Refresh">
          <RefreshCw className={cn('h-3.5 w-3.5', dataLoading && 'animate-spin')} />
        </Button>
        {transferBusy && <span className="text-xs text-muted-foreground">{transferBusy}</span>}
      </div>
      {filterError && (
        <p role="alert" className="border-b bg-destructive/5 px-4 py-1.5 text-xs text-destructive">{filterError}</p>
      )}

      {/* Pagination header */}
      <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
        <span className="text-xs text-muted-foreground">
          {docs?.total ?? 0} document{docs?.total === 1 ? '' : 's'}{showDeleted ? ' (including deleted)' : ''}
        </span>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Page {currentPage} of {totalPages}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Next page" disabled={currentPage >= totalPages} onClick={() => setPage((p) => p + 1)}>
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
              const isDeleted = doc._status === 'deleted';
              const userData = withoutEnvelope(doc);
              const preview = JSON.stringify(userData);
              const full = JSON.stringify(userData, null, 2);

              return (
                <div key={doc._id} className={cn('group transition-colors hover:bg-muted/30', isDeleted && 'opacity-60')}>
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
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Copy ID" aria-label="Copy ID"
                        onClick={() => { navigator.clipboard.writeText(doc._id); toast.success('ID copied'); }}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      {isDeleted ? (
                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Restore" aria-label="Restore document"
                          onClick={() => handleRestoreDoc(doc._id)}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      ) : (
                        <>
                          <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" aria-label="Edit document"
                            onClick={() => { setEditDoc(doc); setEditOpen(true); }}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="Delete" aria-label="Delete document"
                            onClick={() => handleDeleteDoc(doc._id)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <InsertDocDialog open={insertOpen} onOpenChange={setInsertOpen} projectId={projectId} entityName={entityName} onInserted={changed} />
      <EditDocDialog open={editOpen} onOpenChange={setEditOpen} projectId={projectId} entityName={entityName} doc={editDoc} onSaved={changed} />
      <EditEntityDialog
        open={entityEditOpen}
        onOpenChange={setEntityEditOpen}
        projectId={projectId}
        entity={entity}
        onSaved={(updated) => { setEntity(updated); onEntityChanged?.(); }}
      />
    </div>
  );
}
