'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import type { DataQueryCapabilities, DataQueryResult, SavedDataQueryItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Play,
  Loader2,
  Trash2,
  Copy,
  Check,
  Plus,
  X,
  FileDown,
  HelpCircle,
  ChevronDown,
  Save,
} from 'lucide-react';

interface QueryEditorProps {
  projectId: string;
}

type QueryMode = 'js' | 'aggregation';

interface QueryTab {
  id: string;
  title: string;
  query: string;
  result: DataQueryResult | null;
  error: string | null;
  executedQuery?: string;
  /** Query dialect for this tab. Tabs persisted before this field default to 'js'. */
  mode?: QueryMode;
  /** Target entity — required for aggregation mode (pipelines are entity-scoped). */
  entity?: string;
}

const DEFAULT_QUERY = "collection('my_collection')\n  .find({})\n  .limit(50)";
const DEFAULT_PIPELINE = `[
  { "$match": { "status": "active" } },
  { "$sort": { "_createdAt": -1 } },
  { "$limit": 50 }
]`;
const CELL_TRUNCATE_LENGTH = 120;

function createTab(index: number, mode: QueryMode = 'js'): QueryTab {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `Query ${index}`,
    query: mode === 'aggregation' ? DEFAULT_PIPELINE : DEFAULT_QUERY,
    result: null,
    error: null,
    mode,
  };
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function QueryEditor({ projectId }: QueryEditorProps) {
  const storageKey = `basefyio_query_editor_tabs_${projectId}`;
  const [tabs, setTabs] = useState<QueryTab[]>([createTab(1)]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [runningTabId, setRunningTabId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  const [showReference, setShowReference] = useState(false);
  const [entityNames, setEntityNames] = useState<string[]>([]);
  const [collectionNames, setCollectionNames] = useState<string[]>([]);
  const [savedQueries, setSavedQueries] = useState<SavedDataQueryItem[]>([]);
  const [selectedSavedId, setSelectedSavedId] = useState<string>('');
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [capabilities, setCapabilities] = useState<DataQueryCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const caps = await api.dataQuery.capabilities(projectId).catch(() => null);
      if (!cancelled) setCapabilities(caps);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        const first = createTab(1);
        setTabs([first]);
        setActiveTabId(first.id);
        return;
      }
      const parsed = JSON.parse(raw) as { tabs: QueryTab[]; activeTabId: string };
      if (!parsed.tabs?.length) {
        const first = createTab(1);
        setTabs([first]);
        setActiveTabId(first.id);
        return;
      }
      setTabs(parsed.tabs);
      setActiveTabId(parsed.activeTabId || parsed.tabs[0].id);
    } catch {
      const first = createTab(1);
      setTabs([first]);
      setActiveTabId(first.id);
    }
  }, [storageKey]);

  useEffect(() => {
    if (!activeTabId || tabs.length === 0) return;
    localStorage.setItem(storageKey, JSON.stringify({ tabs, activeTabId }));
  }, [tabs, activeTabId, storageKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [entities, collections] = await Promise.all([
        api.projects.listEntityDefinitions(projectId).catch(() => []),
        api.projects.listCollections(projectId).catch(() => []),
      ]);
      if (cancelled) return;
      setEntityNames(entities.map((e) => e.logicalName).sort());
      setCollectionNames(collections.map((c) => c.name).sort());
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const items = await api.dataQuery.listSaved(projectId).catch(() => []);
      if (!cancelled) setSavedQueries(items);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  const query = activeTab?.query ?? '';
  const result = activeTab?.result ?? null;
  const error = activeTab?.error ?? null;
  const running = runningTabId === activeTabId;
  const tabMode: QueryMode = activeTab?.mode ?? 'js';
  const tabEntity = activeTab?.entity ?? '';
  const aggregationAvailable = capabilities?.queryModes.includes('aggregation') ?? false;

  function setTabMode(mode: QueryMode) {
    updateActiveTab((t) => {
      if ((t.mode ?? 'js') === mode) return t;
      const isUntouched =
        t.query.trim() === '' ||
        t.query === DEFAULT_QUERY ||
        t.query === DEFAULT_PIPELINE;
      return {
        ...t,
        mode,
        // Swap in the dialect's starter template only if the user hasn't typed anything.
        query: isUntouched ? (mode === 'aggregation' ? DEFAULT_PIPELINE : DEFAULT_QUERY) : t.query,
        result: null,
        error: null,
        executedQuery: undefined,
      };
    });
  }

  function escapeMarkdownCell(value: unknown): string {
    const text = formatCellValue(value);
    return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  function buildMarkdownTable(queryResult: DataQueryResult): string {
    if (!queryResult.fields?.length) {
      return 'Query executed successfully.';
    }
    const headers = queryResult.fields.map((f) => f.name);
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const rows = (queryResult.rows ?? []).map((row) => {
      const cells = headers.map((h) => escapeMarkdownCell((row as Record<string, unknown>)[h]));
      return `| ${cells.join(' | ')} |`;
    });
    return [head, sep, ...rows].join('\n');
  }

  function updateActiveTab(
    updater: (tab: QueryTab) => QueryTab,
  ) {
    if (!activeTabId) return;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? updater(t) : t)));
  }

  function addTab() {
    const next = createTab(tabs.length + 1);
    setTabs((prev) => [...prev, next]);
    setActiveTabId(next.id);
  }

  function closeTab(tabId: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0) {
        const first = createTab(1);
        setActiveTabId(first.id);
        return [first];
      }
      if (activeTabId === tabId) {
        const idx = prev.findIndex((t) => t.id === tabId);
        const fallback = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveTabId(fallback.id);
      }
      return next;
    });
  }

  function startRenaming(tab: QueryTab) {
    setRenamingTabId(tab.id);
    setRenameValue(tab.title);
  }

  function commitRename(tabId: string) {
    const nextTitle = renameValue.trim();
    if (!nextTitle) {
      setRenamingTabId(null);
      setRenameValue('');
      return;
    }
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, title: nextTitle } : t)),
    );
    setRenamingTabId(null);
    setRenameValue('');
  }

  async function execute(page = 1, queryOverride?: string) {
    const q = queryOverride ?? query;
    if (!activeTab || !q.trim()) return;

    if (tabMode === 'aggregation') {
      if (!tabEntity) {
        toast.error('Select a target entity for the aggregation');
        return;
      }
      let pipeline: unknown[];
      try {
        pipeline = JSON.parse(q);
      } catch (err: any) {
        const msg = `Pipeline is not valid JSON: ${err.message}`;
        updateActiveTab((t) => ({ ...t, error: msg, result: null }));
        toast.error(msg);
        return;
      }
      if (!Array.isArray(pipeline)) {
        const msg = 'Pipeline must be a JSON array of stages, e.g. [{ "$match": {...} }]';
        updateActiveTab((t) => ({ ...t, error: msg, result: null }));
        toast.error(msg);
        return;
      }
      setRunningTabId(activeTab.id);
      updateActiveTab((t) => ({ ...t, error: null, result: null }));
      try {
        const data = await api.dataQuery.executeAggregation(projectId, tabEntity, pipeline);
        updateActiveTab((t) => ({ ...t, result: data, executedQuery: q }));
      } catch (err: any) {
        updateActiveTab((t) => ({ ...t, error: err.message }));
        toast.error(err.message);
      } finally {
        setRunningTabId(null);
      }
      return;
    }

    setRunningTabId(activeTab.id);
    if (page === 1) {
      updateActiveTab((t) => ({ ...t, error: null, result: null }));
    }
    try {
      const data = await api.dataQuery.executeJs(projectId, q, { page, limit: 100 });
      updateActiveTab((t) => ({ ...t, result: data, executedQuery: q }));
    } catch (err: any) {
      updateActiveTab((t) => ({ ...t, error: err.message }));
      toast.error(err.message);
    } finally {
      setRunningTabId(null);
    }
  }

  function goToPage(page: number) {
    if (!activeTab?.executedQuery) return;
    void execute(page, activeTab.executedQuery);
  }

  function copyResultAsMarkdown() {
    if (!result) return;
    navigator.clipboard.writeText(buildMarkdownTable(result));
    toast.success('Result copied as Markdown');
  }

  function copyResultAsJson() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result.rows ?? [], null, 2));
    toast.success('Result copied as JSON');
  }

  function downloadResultAsExcel() {
    if (!result) return;
    if (!result.fields?.length) {
      toast.error('No tabular result to export');
      return;
    }
    const headers = result.fields.map((f) => f.name);
    const rows = (result.rows ?? []).map((row) =>
      headers.map((h) => {
        const value = (row as Record<string, unknown>)[h];
        if (value === null || value === undefined) return '';
        if (typeof value === 'object') return JSON.stringify(value);
        return value;
      }),
    );
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Query Result');
    XLSX.writeFile(
      workbook,
      `query-result-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`,
    );
    toast.success('Excel downloaded');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      execute();
    }
  }

  function insertNameTemplate(name: string) {
    if (tabMode === 'aggregation') {
      // Pipelines are entity-scoped — picking a name sets the target entity.
      updateActiveTab((t) => ({ ...t, entity: name }));
      return;
    }
    const snippet = `collection('${name}')\n  .find({})\n  .limit(50)`;
    updateActiveTab((t) => ({
      ...t,
      query: t.query.trim() ? `${t.query}\n\n${snippet}` : snippet,
    }));
  }

  async function refreshSavedQueries() {
    const items = await api.dataQuery.listSaved(projectId).catch(() => []);
    setSavedQueries(items);
  }

  function openSavedQuery(item: SavedDataQueryItem) {
    const mode: QueryMode = item.mode === 'aggregation' ? 'aggregation' : 'js';
    const tab: QueryTab = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: item.name,
      query: item.source,
      result: null,
      error: null,
      mode,
      ...(mode === 'aggregation' && item.entity ? { entity: item.entity } : {}),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  async function handleSaveQuery() {
    const name = saveName.trim();
    if (!name || !activeTab || !activeTab.query.trim()) return;
    setSaving(true);
    try {
      const entityMatch =
        tabMode === 'aggregation'
          ? null
          : (activeTab.query.match(/collection\(\s*['"]([^'"]+)['"]\s*\)/) ??
            activeTab.query.match(/\bdb\.([A-Za-z_$][\w$]*)/));
      const entity = tabMode === 'aggregation' ? tabEntity || undefined : entityMatch?.[1];
      await api.dataQuery.saveQuery(projectId, {
        name,
        source: activeTab.query,
        mode: tabMode,
        ...(entity ? { entity } : {}),
      });
      toast.success('Query saved');
      setSaveDialogOpen(false);
      setSaveName('');
      await refreshSavedQueries();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedSaved() {
    const item = savedQueries.find((q) => q.id === selectedSavedId);
    if (!item) return;
    if (!confirm(`Delete saved query "${item.name}"?`)) return;
    try {
      await api.dataQuery.deleteSaved(projectId, item.id);
      toast.success('Saved query deleted');
      setSelectedSavedId('');
      await refreshSavedQueries();
    } catch (err: any) {
      toast.error(err.message);
    }
  }

  const insertableNames = entityNames.length + collectionNames.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-1 overflow-x-auto rounded-md border bg-muted/30 p-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={`inline-flex cursor-pointer items-center gap-2 rounded px-2.5 py-1 text-xs ${
              tab.id === activeTabId ? 'bg-background font-medium' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {renamingTabId === tab.id ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => commitRename(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename(tab.id);
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenamingTabId(null);
                    setRenameValue('');
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-[140px] rounded border bg-background px-1.5 py-0.5 text-xs"
              />
            ) : (
              <button
                type="button"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRenaming(tab);
                }}
                className="max-w-[140px] truncate text-left"
                title="Double-click to rename"
              >
                {tab.title}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="rounded p-0.5 hover:bg-muted"
              aria-label={`Close ${tab.title}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={addTab}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {aggregationAvailable && (
            <div
              className="flex items-center rounded-md border bg-muted/30 p-0.5"
              role="radiogroup"
              aria-label="Query mode"
            >
              <button
                type="button"
                role="radio"
                aria-checked={tabMode === 'js'}
                onClick={() => setTabMode('js')}
                className={`rounded px-2.5 py-1 text-xs ${
                  tabMode === 'js' ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                JS
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={tabMode === 'aggregation'}
                onClick={() => setTabMode('aggregation')}
                className={`rounded px-2.5 py-1 text-xs ${
                  tabMode === 'aggregation' ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                Aggregation
              </button>
            </div>
          )}
          {tabMode === 'aggregation' && (
            <Select
              value={tabEntity}
              onValueChange={(name) => updateActiveTab((t) => ({ ...t, entity: name }))}
              disabled={entityNames.length === 0}
            >
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue placeholder={entityNames.length === 0 ? 'No entities' : 'Target entity'} />
              </SelectTrigger>
              <SelectContent>
                {entityNames.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono text-xs">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={insertableNames === 0}>
                Insert name
                <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {entityNames.length > 0 && (
                <>
                  <DropdownMenuLabel>Entities</DropdownMenuLabel>
                  {entityNames.map((name) => (
                    <DropdownMenuItem
                      key={`entity-${name}`}
                      className="font-mono text-xs"
                      onClick={() => insertNameTemplate(name)}
                    >
                      {name}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {entityNames.length > 0 && collectionNames.length > 0 && <DropdownMenuSeparator />}
              {collectionNames.length > 0 && (
                <>
                  <DropdownMenuLabel>Collections</DropdownMenuLabel>
                  {collectionNames.map((name) => (
                    <DropdownMenuItem
                      key={`collection-${name}`}
                      className="font-mono text-xs"
                      onClick={() => insertNameTemplate(name)}
                    >
                      {name}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${showReference ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}`}
            onClick={() => setShowReference((v) => !v)}
            title="Query dialect reference"
            aria-label="Query dialect reference"
          >
            <HelpCircle className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selectedSavedId}
            onValueChange={(id) => {
              setSelectedSavedId(id);
              const item = savedQueries.find((q) => q.id === id);
              if (item) openSavedQuery(item);
            }}
            disabled={savedQueries.length === 0}
          >
            <SelectTrigger className="h-8 w-[200px] text-xs">
              <SelectValue placeholder={savedQueries.length === 0 ? 'No saved queries' : 'Saved queries'} />
            </SelectTrigger>
            <SelectContent>
              {savedQueries.map((item) => (
                <SelectItem key={item.id} value={item.id} className="text-xs">
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={deleteSelectedSaved}
            disabled={!selectedSavedId}
            title="Delete selected saved query"
            aria-label="Delete selected saved query"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setSaveName(activeTab?.title ?? '');
              setSaveDialogOpen(true);
            }}
            disabled={!query.trim()}
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </div>

      {showReference && tabMode === 'aggregation' && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">Aggregation pipeline reference</p>
          <p>
            The editor holds a JSON array of stages, executed in order against the selected entity.
          </p>
          <p>
            Stages:{' '}
            <code className="font-mono text-foreground">$match $project $unwind $group $sort $limit $skip</code>
          </p>
          <p>
            <code className="font-mono text-foreground">{'{ "$match": { "status": "active", "total": { "$gt": 100 } } }'}</code>
          </p>
          <p>
            <code className="font-mono text-foreground">{'{ "$group": { "_id": "customer.city", "orders": { "$count": null }, "revenue": { "$sum": "total" } } }'}</code>
          </p>
          <p>
            <code className="font-mono text-foreground">{'{ "$sort": { "revenue": -1 } }'}</code>{' '}
            · <code className="font-mono text-foreground">{'{ "$limit": 10 }'}</code>{' '}
            · <code className="font-mono text-foreground">{'{ "$unwind": "items[]" }'}</code>{' '}
            · <code className="font-mono text-foreground">{'{ "$project": { "name": 1, "city": "customer.city" } }'}</code>
          </p>
          <p>
            Accumulators: <code className="font-mono text-foreground">$count $sum $avg $min $max</code> — blocked
            stages: <code className="font-mono text-foreground">$lookup $out $merge $function $where</code>
          </p>
        </div>
      )}

      {showReference && tabMode === 'js' && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">Query dialect reference</p>
          <p>
            Root: <code className="font-mono text-foreground">collection(&apos;name&apos;)</code> or{' '}
            <code className="font-mono text-foreground">db.name</code>
          </p>
          <p>
            <code className="font-mono text-foreground">.find({'{...}'})</code> — operators:{' '}
            <code className="font-mono text-foreground">
              $eq $ne $gt $gte $lt $lte $in $nin $contains $containsAny $exists $regex $iregex $like $ilike
            </code>{' '}
            and logical <code className="font-mono text-foreground">$and / $or / $not</code>
          </p>
          <p>
            <code className="font-mono text-foreground">.sort({'{field: 1 | -1}'})</code> or{' '}
            <code className="font-mono text-foreground">.sort(&apos;field&apos;, &apos;asc&apos;)</code>
          </p>
          <p>
            <code className="font-mono text-foreground">.limit(n)</code> ·{' '}
            <code className="font-mono text-foreground">.skip(n)</code> ·{' '}
            <code className="font-mono text-foreground">.select({'{field: 1}'})</code> ·{' '}
            <code className="font-mono text-foreground">.count()</code>
          </p>
          <p>
            Use dotted paths for nested fields:{' '}
            <code className="font-mono text-foreground">&apos;customer.address.city&apos;</code>
          </p>
        </div>
      )}

      <div className="relative shrink-0">
        <textarea
          value={query}
          onChange={(e) =>
            updateActiveTab((t) => ({
              ...t,
              query: e.target.value,
            }))
          }
          onKeyDown={handleKeyDown}
          className="h-[38vh] min-h-[260px] w-full resize-y rounded-md border bg-muted/30 p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={
            tabMode === 'aggregation'
              ? '[\n  { "$match": { "status": "active" } },\n  { "$limit": 50 }\n]'
              : "collection('orders').find({ status: 'paid' }).sort({ _createdAt: -1 }).limit(50)"
          }
          spellCheck={false}
        />
        <div className="absolute bottom-3 right-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              updateActiveTab((t) => ({ ...t, query: '', result: null, error: null }))
            }
            disabled={running || (!query && !result && !error)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Clear
          </Button>
          <Button onClick={() => execute()} disabled={running || !query.trim()} size="sm">
            {running ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Run (Ctrl+Enter)
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
            onClick={() => {
              navigator.clipboard.writeText(error);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            title="Copy error"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center gap-4">
              <span>
                {result.paginated && (result.total ?? null) !== null
                  ? `${result.total}${result.totalIsApprox ? '+' : ''} total · page ${result.page ?? 1}`
                  : `${result.rowCount ?? 0} rows${result.paginated ? ` (page ${result.page ?? 1})` : ''}`}
              </span>
              <span>{result.duration}ms</span>
              {result.paginated && (
                <div className="flex items-center gap-1">
                  <Button type="button" variant="outline" size="sm" disabled={runningTabId === activeTab?.id || (result.page ?? 1) <= 1} onClick={() => goToPage((result.page ?? 1) - 1)}>Prev</Button>
                  <Button type="button" variant="outline" size="sm" disabled={runningTabId === activeTab?.id || ((result.rows?.length ?? 0) < (result.limit ?? 100))} onClick={() => goToPage((result.page ?? 1) + 1)}>Next</Button>
                </div>
              )}
              <div
                className="flex items-center rounded-md border bg-muted/30 p-0.5"
                role="radiogroup"
                aria-label="Result view"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={viewMode === 'table'}
                  onClick={() => setViewMode('table')}
                  className={`rounded px-2.5 py-0.5 text-xs ${
                    viewMode === 'table' ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  Table
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={viewMode === 'json'}
                  onClick={() => setViewMode('json')}
                  className={`rounded px-2.5 py-0.5 text-xs ${
                    viewMode === 'json' ? 'bg-background font-medium text-foreground' : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  JSON
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={copyResultAsMarkdown}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy as Markdown
              </Button>
              <Button variant="outline" size="sm" onClick={copyResultAsJson}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy as JSON
              </Button>
              <Button variant="outline" size="sm" onClick={downloadResultAsExcel}>
                <FileDown className="mr-1.5 h-3.5 w-3.5" />
                Download Excel
              </Button>
            </div>
          </div>

          {viewMode === 'json' ? (
            <pre className="max-h-[52vh] overflow-auto rounded-md border bg-muted/30 p-4 font-mono text-xs">
              {JSON.stringify(result.rows ?? [], null, 2)}
            </pre>
          ) : result.fields?.length ? (
            <div className="overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {result.fields.map((field) => (
                      <th
                        key={field.name}
                        className="px-4 py-2 text-left font-medium"
                      >
                        {field.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(result.rows ?? []).map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      {result.fields!.map((field) => {
                        const text = formatCellValue(row[field.name]);
                        const truncated = text.length > CELL_TRUNCATE_LENGTH;
                        return (
                          <td
                            key={field.name}
                            className="max-w-[420px] truncate px-4 py-2 font-mono"
                            title={truncated ? text : undefined}
                          >
                            {truncated ? `${text.slice(0, CELL_TRUNCATE_LENGTH)}…` : text}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              Query executed successfully.
            </div>
          )}
        </div>
      )}

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Save query</DialogTitle>
            <DialogDescription>
              Save the active tab&apos;s query so you can reuse it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="query-save-name">Name</Label>
            <Input
              id="query-save-name"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="My query"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSaveQuery();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSaveDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSaveQuery()} disabled={saving || !saveName.trim()}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
