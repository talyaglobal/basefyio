'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { subscribebasefyioRealtime } from '@/lib/basefyio-realtime';
import type { DocumentRecord, DocumentListResult, CollectionIndexInfo } from '@/lib/types';
import { chunk, downloadJson, readJsonDocuments } from '@/lib/json-transfer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  Download,
  KeyRound,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';

/**
 * Parse what the user typed. A document must be a JSON object (inserts may
 * also be an array of objects) — a bare string or number is valid JSON but
 * not a document, so say that instead of letting the server call it invalid.
 */
function parseDocumentInput(
  text: string,
  allowArray: boolean,
): { value?: Record<string, unknown> | Record<string, unknown>[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: any) {
    return { error: `Invalid JSON: ${err?.message ?? 'cannot parse'}` };
  }
  const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObject(parsed)) return { value: parsed as Record<string, unknown> };
  if (allowArray && Array.isArray(parsed)) {
    if (parsed.length === 0) return { error: 'The array is empty — add at least one document' };
    const bad = parsed.findIndex((d) => !isObject(d));
    if (bad === -1) return { value: parsed as Record<string, unknown>[] };
    return { error: `Item ${bad + 1} of the array is not a JSON object` };
  }
  return {
    error: allowArray
      ? 'A document must be a JSON object such as {"name": "value"}, or an array of objects'
      : 'A document must be a JSON object such as {"name": "value"}',
  };
}

function pasteAsPrettyJson(e: React.ClipboardEvent<HTMLTextAreaElement>, set: (v: string) => void) {
  const pasted = e.clipboardData.getData('text');
  try {
    const pretty = JSON.stringify(JSON.parse(pasted), null, 2);
    e.preventDefault();
    set(pretty);
  } catch { /* not JSON — let the default paste happen */ }
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
    const { value: parsed, error } = parseDocumentInput(json, true);
    if (!parsed) {
      toast.error(error);
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
            aria-label="Document JSON"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            onBlur={prettifyJson}
            onPaste={(e) => pasteAsPrettyJson(e, setJson)}
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
    const { value, error } = parseDocumentInput(json, false);
    if (!value) {
      toast.error(error);
      return;
    }
    const parsed = value as Record<string, unknown>;
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
            aria-label="Document JSON"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            onBlur={prettifyJson}
            onPaste={(e) => pasteAsPrettyJson(e, setJson)}
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

// ── Indexes Dialog ─────────────────────────────────────────

function IndexesDialog({
  open,
  onOpenChange,
  projectId,
  collectionName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  collectionName: string;
}) {
  const [indexes, setIndexes] = useState<CollectionIndexInfo[] | null>(null);
  const [fieldPath, setFieldPath] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setIndexes(await api.projects.listCollectionIndexes(projectId, collectionName));
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, collectionName]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const path = fieldPath.trim();
    if (!path) return;
    setBusy(true);
    try {
      await api.projects.createCollectionIndex(projectId, collectionName, path);
      toast.success(`Index created on "${path}"`);
      setFieldPath('');
      await load();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDrop(name: string) {
    if (!(await confirmDialog({ title: 'Drop index', description: `Drop index "${name}"? Queries on that field may become slower.`, confirmText: 'Drop index', destructive: true }))) return;
    try {
      await api.projects.dropCollectionIndex(projectId, collectionName, name);
      toast.success(`Index "${name}" dropped`);
      await load();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Indexes</DialogTitle>
          <DialogDescription>
            Index a field of <strong>{collectionName}</strong> to speed up filters and sorts on it. Nested paths such as
            <code className="mx-1 text-xs">address.city</code> are supported.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          {indexes === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (
            indexes.map((idx) => (
              <div key={idx.name} className="flex items-center gap-2 rounded border px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{idx.fieldPath ?? idx.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {idx.system ? 'Built in — created with the collection' : idx.name}
                  </p>
                </div>
                {!idx.system && (
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Drop index ${idx.name}`} onClick={() => handleDrop(idx.name)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
        <form onSubmit={handleCreate} className="flex items-center gap-2">
          <Input
            className="h-8 text-xs font-mono"
            placeholder="Field path, e.g. status or address.city"
            aria-label="Field path to index"
            value={fieldPath}
            onChange={(e) => setFieldPath(e.target.value)}
          />
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={busy || !fieldPath.trim()}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add index
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Collection Documents Panel ──────────────────────────────

export function CollectionDocumentsPanel({
  projectId,
  collectionName,
  onChanged,
}: {
  projectId: string;
  collectionName: string;
  /** Called after documents were inserted or deleted (the sidebar refreshes its counts). */
  onChanged?: () => void;
}) {
  const [docs, setDocs] = useState<DocumentListResult | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [page, setPage] = useState(0); // offset-based
  const [insertOpen, setInsertOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<DocumentRecord | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());

  const [filterText, setFilterText] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [indexesOpen, setIndexesOpen] = useState(false);
  const [transferBusy, setTransferBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const LIMIT = 50;

  // Reset all per-collection state synchronously when the target changes,
  // so the load effect below only ever runs with fresh values.
  const collectionKey = `${projectId}/${collectionName}`;
  const [prevCollectionKey, setPrevCollectionKey] = useState(collectionKey);
  if (collectionKey !== prevCollectionKey) {
    setPrevCollectionKey(collectionKey);
    setDocs(null);
    setDataLoading(true);
    setPage(0);
    setFilterText('');
    setAppliedFilter('');
    setSelectedDocs(new Set());
    setExpandedDoc(null);
    setFilterError(null);
  }

  // Debounce filter
  useEffect(() => {
    const handle = setTimeout(() => setAppliedFilter(filterText.trim()), 350);
    return () => clearTimeout(handle);
  }, [filterText]);

  // ── Load documents ────────────────────────────────────
  useEffect(() => {
    loadDocuments();
  }, [projectId, collectionName, page, appliedFilter]);

  // ── Live updates ──────────────────────────────────────
  // Collection document writes append project activity, which broadcasts on
  // the project channel — refetch so every open tab reflects changes
  // without a manual refresh. Lightly debounced to coalesce bursts.
  useEffect(() => {
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribebasefyioRealtime(`project:${projectId}`, (event) => {
      const kind = (event.payload as { kind?: string } | undefined)?.kind ?? '';
      if (!kind.startsWith('collection.')) return;
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => {
        void loadDocuments();
      }, 250);
    });
    return () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, collectionName, page, appliedFilter]);

  async function loadDocuments() {
    setDataLoading(true);
    try {
      let filter: Record<string, unknown> | undefined;
      if (appliedFilter) {
        const parsed = parseDocumentInput(appliedFilter, false);
        if (!parsed.value) {
          setFilterError(
            `Filter: ${parsed.error?.replace('A document', 'A filter')}. Examples: {"status":"active"}, {"meta.city":"Ankara"}, {"tags":{"$in":["x"]}}`,
          );
          setDataLoading(false);
          return;
        }
        filter = parsed.value as Record<string, unknown>;
      }
      const result = await api.projects.collectionDocuments(projectId, collectionName, {
        filter,
        limit: LIMIT,
        offset: page * LIMIT,
      });
      setFilterError(null);
      setDocs(result);
      setSelectedDocs(new Set());
    } catch (err: any) {
      if (err?.status === 400 && appliedFilter) setFilterError(err.message);
      else toast.error(err.message);
    } finally {
      setDataLoading(false);
    }
  }

  function changed() {
    void loadDocuments();
    onChanged?.();
  }

  async function handleDeleteDoc(docId: string) {
    if (!(await confirmDialog({
      title: 'Delete document',
      description: 'Delete this document permanently? Collection documents cannot be restored.',
      confirmText: 'Delete',
      destructive: true,
    }))) return;
    try {
      await api.projects.deleteDocument(projectId, collectionName, docId);
      toast.success('Document deleted');
      changed();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleExport() {
    setTransferBusy('Exporting…');
    try {
      const all: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += 1000) {
        const result = await api.projects.collectionDocuments(projectId, collectionName, { limit: 1000, offset });
        all.push(...result.data.map((d) => d.data));
        if (result.data.length < 1000 || offset + result.data.length >= result.total) break;
      }
      downloadJson(`${collectionName}.json`, all);
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
      for (const batch of chunk(documents, 500)) {
        await api.projects.insertDocument(projectId, collectionName, batch);
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

  async function handleBulkDelete() {
    if (selectedDocs.size === 0) return;
    if (!(await confirmDialog({ title: 'Delete documents', description: `Delete ${selectedDocs.size} selected document(s)?`, destructive: true }))) return;
    try {
      // bulk delete by iterating individual deletes (the bulk endpoint uses data filters, not id)
      for (const docId of selectedDocs) {
        await api.projects.deleteDocument(projectId, collectionName, docId);
      }
      toast.success(`${selectedDocs.size} document(s) deleted`);
      setSelectedDocs(new Set());
      changed();
    } catch (err: any) {
      toast.error(err.message);
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

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-mono font-medium text-foreground truncate">{collectionName}</span>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {formatCount(docs?.total ?? 0)}
          </Badge>
        </div>

        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className={cn('h-8 pl-8 text-xs font-mono', filterError && 'border-destructive')}
            placeholder='Filter, e.g. {"status":"active"} or {"meta.city":"Ankara"}'
            aria-label="Filter documents (JSON)"
            aria-invalid={!!filterError}
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              setPage(0);
            }}
          />
        </div>

        {selectedDocs.size > 0 && (
          <Button variant="destructive" size="sm" className="h-8 text-xs" onClick={handleBulkDelete}>
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete ({selectedDocs.size})
          </Button>
        )}

        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadDocuments} title="Refresh" aria-label="Refresh">
          <RefreshCw className={cn('h-3.5 w-3.5', dataLoading && 'animate-spin')} />
        </Button>

        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setInsertOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Insert
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!!transferBusy} onClick={() => fileInput.current?.click()} title="Import a JSON file">
          <Upload className="mr-1 h-3.5 w-3.5" /> Import
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!!transferBusy} onClick={handleExport} title="Export all documents as JSON">
          <Download className="mr-1 h-3.5 w-3.5" /> Export
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setIndexesOpen(true)}>
          <KeyRound className="mr-1 h-3.5 w-3.5" /> Indexes
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
        {transferBusy && <span className="text-xs text-muted-foreground">{transferBusy}</span>}
      </div>
      {filterError && (
        <p role="alert" className="border-b bg-destructive/5 px-4 py-1.5 text-xs text-destructive">{filterError}</p>
      )}

      {/* Header */}
      <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
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

      {/* ── Dialogs ── */}
      <InsertDocumentDialog
        open={insertOpen}
        onOpenChange={setInsertOpen}
        projectId={projectId}
        collectionName={collectionName}
        onInserted={changed}
      />
      <EditDocumentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={projectId}
        collectionName={collectionName}
        doc={editDoc}
        onSaved={loadDocuments}
      />
      <IndexesDialog
        open={indexesOpen}
        onOpenChange={setIndexesOpen}
        projectId={projectId}
        collectionName={collectionName}
      />
    </div>
  );
}
