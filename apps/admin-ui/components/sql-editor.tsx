'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import type { SqlResult } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Play, Loader2, Trash2, Copy, Check, Plus, X, FileDown } from 'lucide-react';

interface SqlEditorProps {
  projectId: string;
}

interface SqlTab {
  id: string;
  title: string;
  query: string;
  result: SqlResult | null;
  error: string | null;
  executedQuery?: string;
}

function createTab(index: number): SqlTab {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: `SQL ${index}`,
    query: 'SELECT NOW();',
    result: null,
    error: null,
  };
}

export function SqlEditor({ projectId }: SqlEditorProps) {
  const storageKey = `kb_sql_editor_tabs_${projectId}`;
  const [tabs, setTabs] = useState<SqlTab[]>([createTab(1)]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [runningTabId, setRunningTabId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        const first = createTab(1);
        setTabs([first]);
        setActiveTabId(first.id);
        return;
      }
      const parsed = JSON.parse(raw) as { tabs: SqlTab[]; activeTabId: string };
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

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  );

  const query = activeTab?.query ?? '';
  const result = activeTab?.result ?? null;
  const error = activeTab?.error ?? null;
  const running = runningTabId === activeTabId;

  function escapeMarkdownCell(value: unknown): string {
    const text = value === null || value === undefined ? 'NULL' : String(value);
    return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  function buildMarkdownTable(sqlResult: SqlResult): string {
    if (!sqlResult.fields?.length) {
      return 'Query executed successfully.';
    }
    const headers = sqlResult.fields.map((f) => f.name);
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const rows = (sqlResult.rows ?? []).map((row) => {
      const cells = headers.map((h) => escapeMarkdownCell((row as Record<string, unknown>)[h]));
      return `| ${cells.join(' | ')} |`;
    });
    return [head, sep, ...rows].join('\n');
  }

  function updateActiveTab(
    updater: (tab: SqlTab) => SqlTab,
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

  function startRenaming(tab: SqlTab) {
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
    setRunningTabId(activeTab.id);
    if (page === 1) {
      updateActiveTab((t) => ({ ...t, error: null, result: null }));
    }
    try {
      const data = await api.sql.execute(projectId, q, { page, limit: 100, countTotal: page === 1 });
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
        return value === null || value === undefined ? '' : value;
      }),
    );
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'SQL Result');
    XLSX.writeFile(
      workbook,
      `sql-result-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`,
    );
    toast.success('Excel downloaded');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      execute();
    }
  }

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
          placeholder="SELECT * FROM ..."
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

          {result.fields?.length ? (
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
                      {result.fields!.map((field) => (
                        <td key={field.name} className="px-4 py-2 font-mono">
                          {row[field.name] === null
                            ? 'NULL'
                            : String(row[field.name])}
                        </td>
                      ))}
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
    </div>
  );
}
