'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import type { SqlField, SqlResult, SqlResultSet } from '@basefyio/sdk';
import { getSdk } from '@/lib/sdk';
import { Button } from '@/components/ui/button';
import { Check, Copy, FileDown, Loader2, Play, Plus, Trash2, X } from 'lucide-react';

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

function ResultTable({ fields, rows }: { fields?: SqlField[]; rows?: Record<string, unknown>[] }) {
  if (!fields?.length) {
    return (
      <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        Query executed successfully.
      </div>
    );
  }
  return (
    <div className="overflow-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            {fields.map((f) => (
              <th key={f.name} className="px-4 py-2 text-left font-medium">{f.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {fields.map((f) => (
                <td key={f.name} className="px-4 py-2 font-mono">
                  {row[f.name] === null ? <span className="text-muted-foreground">NULL</span> : String(row[f.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultSetView({ rs, index }: { rs: SqlResultSet; index: number }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">
        Statement {index + 1}
        {rs.fields?.length
          ? ` · ${rs.rows?.length ?? 0} ${(rs.rows?.length ?? 0) === 1 ? 'row' : 'rows'}`
          : rs.rowCount != null
            ? ` · ${rs.rowCount} affected`
            : ' · executed'}
      </div>
      <ResultTable fields={rs.fields} rows={rs.rows} />
    </div>
  );
}

export function SqlEditor({ projectId }: SqlEditorProps) {
  const storageKey = `basefyio_sql_tabs_${projectId}`;
  const [tabs, setTabs] = useState<SqlTab[]>([createTab(1)]);
  const [activeTabId, setActiveTabId] = useState('');
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

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const query = activeTab?.query ?? '';
  const result = activeTab?.result ?? null;
  const error = activeTab?.error ?? null;
  const running = runningTabId === activeTabId;

  function updateActiveTab(updater: (t: SqlTab) => SqlTab) {
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
        setActiveTabId((next[Math.max(0, idx - 1)] ?? next[0]).id);
      }
      return next;
    });
  }

  function commitRename(tabId: string) {
    const title = renameValue.trim();
    if (title) setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title } : t)));
    setRenamingTabId(null);
    setRenameValue('');
  }

  async function execute(page = 1, queryOverride?: string) {
    const q = queryOverride ?? query;
    if (!activeTab || !q.trim()) return;
    setRunningTabId(activeTab.id);
    if (page === 1) updateActiveTab((t) => ({ ...t, error: null, result: null }));
    try {
      const data = await getSdk().withProject(projectId).sql.execute(q, { page, limit: 100, countTotal: page === 1 });
      updateActiveTab((t) => ({ ...t, result: data, executedQuery: q }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      updateActiveTab((t) => ({ ...t, error: msg }));
      toast.error(msg);
    } finally {
      setRunningTabId(null);
    }
  }

  function goToPage(page: number) {
    if (!activeTab?.executedQuery) return;
    void execute(page, activeTab.executedQuery);
  }

  function copyMarkdown() {
    if (!result?.fields?.length) return;
    const headers = result.fields.map((f) => f.name);
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const rows = (result.rows ?? []).map((r) => `| ${headers.map((h) => String((r as Record<string, unknown>)[h] ?? 'NULL').replace(/\|/g, '\\|')).join(' | ')} |`);
    navigator.clipboard.writeText([head, sep, ...rows].join('\n'));
    toast.success('Copied as Markdown');
  }

  function copyJson() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result.rows ?? [], null, 2));
    toast.success('Copied as JSON');
  }

  function downloadExcel() {
    if (!result?.fields?.length) { toast.error('No tabular result'); return; }
    const headers = result.fields.map((f) => f.name);
    const rows = (result.rows ?? []).map((r) => headers.map((h) => (r as Record<string, unknown>)[h] ?? ''));
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Result');
    XLSX.writeFile(wb, `sql-result-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`);
    toast.success('Excel downloaded');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-center gap-1 overflow-x-auto rounded-md border bg-muted/30 p-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={`inline-flex cursor-pointer items-center gap-2 rounded px-2.5 py-1 text-xs ${tab.id === activeTabId ? 'bg-background font-medium' : 'text-muted-foreground hover:bg-muted'}`}
          >
            {renamingTabId === tab.id ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => commitRename(tab.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(tab.id); }
                  if (e.key === 'Escape') { e.preventDefault(); setRenamingTabId(null); }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-[120px] rounded border bg-background px-1.5 py-0.5 text-xs"
              />
            ) : (
              <button
                type="button"
                onDoubleClick={(e) => { e.stopPropagation(); setRenamingTabId(tab.id); setRenameValue(tab.title); }}
                className="max-w-[120px] truncate text-left"
                title="Double-click to rename"
              >
                {tab.title}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              className="rounded p-0.5 hover:bg-muted"
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
          onChange={(e) => updateActiveTab((t) => ({ ...t, query: e.target.value }))}
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void execute(); } }}
          className="h-[38vh] min-h-[220px] w-full resize-y rounded-md border bg-muted/30 p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="SELECT * FROM ..."
          spellCheck={false}
        />
        <div className="absolute bottom-3 right-3 flex gap-2">
          <Button variant="outline" size="sm" onClick={() => updateActiveTab((t) => ({ ...t, query: '', result: null, error: null }))} disabled={running || (!query && !result && !error)}>
            <Trash2 className="mr-1.5 h-4 w-4" />Clear
          </Button>
          <Button size="sm" disabled={running || !query.trim()} onClick={() => { void execute(); }}>
            {running ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
            Run
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
            onClick={() => { navigator.clipboard.writeText(error); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <div className="flex flex-wrap items-center gap-4">
              <span>
                {result.resultSets?.length > 1
                  ? `${result.resultSets.length} statements`
                  : result.paginated && result.total != null
                    ? `${result.total}${result.totalIsApprox ? '+' : ''} total · page ${result.page}`
                    : `${result.rowCount ?? 0} rows`}
              </span>
              <span>{result.duration}ms</span>
              {result.paginated && (
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" disabled={running || result.page <= 1} onClick={() => goToPage(result.page - 1)}>Prev</Button>
                  <Button variant="outline" size="sm" disabled={running || (result.rows?.length ?? 0) < result.limit} onClick={() => goToPage(result.page + 1)}>Next</Button>
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={copyMarkdown}><Copy className="mr-1.5 h-3.5 w-3.5" />Markdown</Button>
              <Button variant="outline" size="sm" onClick={copyJson}><Copy className="mr-1.5 h-3.5 w-3.5" />JSON</Button>
              <Button variant="outline" size="sm" onClick={downloadExcel}><FileDown className="mr-1.5 h-3.5 w-3.5" />Excel</Button>
            </div>
          </div>

          {result.resultSets?.length > 1
            ? <div className="space-y-4">{result.resultSets.map((rs, i) => <ResultSetView key={i} rs={rs} index={i} />)}</div>
            : <ResultTable fields={result.fields} rows={result.rows} />}
        </div>
      )}
    </div>
  );
}
