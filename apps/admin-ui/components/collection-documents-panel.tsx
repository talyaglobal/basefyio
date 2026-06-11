'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { DocumentRecord, DocumentListResult } from '@/lib/types';
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
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';

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

// ── Collection Documents Panel ──────────────────────────────

export function CollectionDocumentsPanel({ projectId, collectionName }: { projectId: string; collectionName: string }) {
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

  async function loadDocuments() {
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
      const result = await api.projects.collectionDocuments(projectId, collectionName, {
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

  async function handleDeleteDoc(docId: string) {
    try {
      await api.projects.deleteDocument(projectId, collectionName, docId);
      toast.success('Document deleted');
      loadDocuments();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  async function handleBulkDelete() {
    if (selectedDocs.size === 0) return;
    if (!confirm(`Delete ${selectedDocs.size} selected document(s)?`)) return;
    try {
      // bulk delete by iterating individual deletes (the bulk endpoint uses data filters, not id)
      for (const docId of selectedDocs) {
        await api.projects.deleteDocument(projectId, collectionName, docId);
      }
      toast.success(`${selectedDocs.size} document(s) deleted`);
      setSelectedDocs(new Set());
      loadDocuments();
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
            className="h-8 pl-8 text-xs font-mono"
            placeholder='Filter JSON, e.g. {"status":"active"}'
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

        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={loadDocuments} title="Refresh">
          <RefreshCw className={cn('h-3.5 w-3.5', dataLoading && 'animate-spin')} />
        </Button>

        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setInsertOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Insert
        </Button>
      </div>

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
        onInserted={loadDocuments}
      />
      <EditDocumentDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        projectId={projectId}
        collectionName={collectionName}
        doc={editDoc}
        onSaved={loadDocuments}
      />
    </div>
  );
}
