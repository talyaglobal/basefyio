'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import { api } from '@/lib/api';
import type { SqlHistoryEntry, SqlResult, SqlSnippet } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { confirmDialog, promptDialog } from '@/components/ui/confirm-dialog';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { csvField, exportCellValue, formatCellTitle, formatCellValue } from '@/lib/cell-format';
import { formatSql } from '@/lib/sql-format';
import { formatCount } from '@/lib/utils';
import {
  Play,
  Loader2,
  Trash2,
  Copy,
  Check,
  Plus,
  X,
  FileDown,
  Square,
  Wand2,
  Save,
  BookMarked,
  History,
  Sparkles,
} from 'lucide-react';

interface SqlEditorProps {
  projectId: string;
}

/** What a tab keeps between reloads: its name and its query — never results. */
interface SqlTab {
  id: string;
  title: string;
  query: string;
  /** The saved query this tab was opened from or saved as. */
  snippetId?: string | null;
}

/** The last run of a tab. Held in memory only. */
interface TabRun {
  result: SqlResult | null;
  error: string | null;
  executedQuery?: string;
  /** Total from the first page, carried while paging. */
  total?: number | null;
  totalIsApprox?: boolean;
}

const DEFAULT_QUERY = 'SELECT NOW();';
const PAGE_SIZE = 100;
/** Rows per result for statements that cannot be paged (scripts, writes). */
const MAX_ROWS = 1000;
/** Most rows a download fetches by paging through a query. */
const EXPORT_ROW_CAP = 10_000;

/**
 * Tabs live in sessionStorage, which belongs to one browser tab: two browser
 * tabs on the same project each keep their own queries instead of overwriting
 * each other through a shared localStorage entry. localStorage keeps only a
 * copy of the latest tab names and queries, to start a new browser tab from.
 * Result rows are never stored — they are table data, and they used to fill
 * the storage quota and stay behind on shared computers.
 */
const sessionKey = (projectId: string) => `basefyio_sql_editor_session_${projectId}`;
const seedKey = (projectId: string) => `basefyio_sql_editor_tabs_${projectId}`;

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // RFC 4122 v4 shape, for the rare browser without randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function createTab(index: number, init?: Partial<SqlTab>): SqlTab {
  return { id: newId(), title: `SQL ${index}`, query: DEFAULT_QUERY, snippetId: null, ...init };
}

function sanitizeTabs(raw: unknown): { tabs: SqlTab[]; activeTabId: string } | null {
  const parsed = raw as { tabs?: unknown[]; activeTabId?: string } | null;
  if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
  const tabs: SqlTab[] = parsed.tabs
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => ({
      id: typeof t.id === 'string' && t.id ? t.id : newId(),
      title: typeof t.title === 'string' && t.title ? t.title : `SQL ${i + 1}`,
      query: typeof t.query === 'string' ? t.query : '',
      snippetId: typeof t.snippetId === 'string' ? t.snippetId : null,
    }));
  if (!tabs.length) return null;
  const activeTabId = tabs.some((t) => t.id === parsed.activeTabId) ? (parsed.activeTabId as string) : tabs[0].id;
  return { tabs, activeTabId };
}

function readStorage(storage: 'session' | 'local', key: string): unknown {
  try {
    const raw = (storage === 'session' ? sessionStorage : localStorage).getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(storage: 'session' | 'local', key: string, value: unknown) {
  try {
    (storage === 'session' ? sessionStorage : localStorage).setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage disabled: tabs simply are not remembered.
  }
}

function loadInitialTabs(projectId: string): { tabs: SqlTab[]; activeTabId: string } {
  const own = sanitizeTabs(readStorage('session', sessionKey(projectId)));
  if (own) return own;
  const seedRaw = readStorage('local', seedKey(projectId));
  const seed = sanitizeTabs(seedRaw);
  if (seed) {
    // Older versions stored result rows here too; rewrite the entry without them.
    writeStorage('local', seedKey(projectId), seed);
    return seed;
  }
  const first = createTab(1);
  return { tabs: [first], activeTabId: first.id };
}

function rowLabel(n: number): string {
  return `${formatCount(n)} ${n === 1 ? 'row' : 'rows'}`;
}

function ResultTable({
  fields,
  rows,
}: {
  fields?: { name: string; dataTypeId: number }[];
  rows?: Record<string, unknown>[];
}) {
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
        <thead className="sticky top-0 z-[1]">
          <tr className="border-b bg-muted">
            {fields.map((field) => (
              <th key={field.name} className="whitespace-nowrap px-4 py-2 text-left font-medium">
                {field.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((row, i) => (
            <tr key={i} className="border-b last:border-0">
              {fields.map((field) => {
                const value = row[field.name];
                return (
                  <td
                    key={field.name}
                    className="max-w-[420px] truncate whitespace-nowrap px-4 py-2 font-mono text-xs"
                    title={formatCellTitle(value)}
                  >
                    {value === null || value === undefined ? (
                      <span className="italic text-muted-foreground/60">NULL</span>
                    ) : (
                      formatCellValue(value)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** First ```sql block of an assistant reply (or the first code block). */
function extractSql(reply: string): string | null {
  const m = /```(?:sql|postgresql|pgsql)?\s*\n([\s\S]*?)```/i.exec(reply);
  return m ? m[1].trim() : null;
}

export function SqlEditor({ projectId }: SqlEditorProps) {
  const [tabs, setTabs] = useState<SqlTab[]>(() => [createTab(1)]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [runs, setRuns] = useState<Record<string, TabRun>>({});
  const [runningTabId, setRunningTabId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const runRef = useRef<{ tabId: string; runId: string; controller: AbortController } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Saved queries, history, assistant
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [snippets, setSnippets] = useState<SqlSnippet[] | null>(null);
  const [snippetFilter, setSnippetFilter] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SqlHistoryEntry[] | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiReply, setAiReply] = useState<string | null>(null);

  useEffect(() => {
    const initial = loadInitialTabs(projectId);
    setTabs(initial.tabs);
    setActiveTabId(initial.activeTabId);
    setRuns({});
    setLoaded(true);
  }, [projectId]);

  // Remember this browser tab's tabs (and seed new browser tabs), lightly debounced.
  useEffect(() => {
    if (!loaded || !activeTabId) return;
    const handle = setTimeout(() => {
      const value = {
        tabs: tabs.map(({ id, title, query, snippetId }) => ({ id, title, query, snippetId: snippetId ?? null })),
        activeTabId,
      };
      writeStorage('session', sessionKey(projectId), value);
      writeStorage('local', seedKey(projectId), value);
    }, 300);
    return () => clearTimeout(handle);
  }, [tabs, activeTabId, projectId, loaded]);

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);
  const run: TabRun = (activeTab && runs[activeTab.id]) || { result: null, error: null };
  const query = activeTab?.query ?? '';
  const result = run.result;
  const error = run.error;
  const running = !!activeTab && runningTabId === activeTab.id;

  const setRun = useCallback((tabId: string, update: (prev: TabRun) => TabRun) => {
    setRuns((prev) => ({ ...prev, [tabId]: update(prev[tabId] ?? { result: null, error: null }) }));
  }, []);

  function updateActiveTab(updater: (tab: SqlTab) => SqlTab) {
    if (!activeTabId) return;
    setTabs((prev) => prev.map((t) => (t.id === activeTabId ? updater(t) : t)));
  }

  function addTab(init?: Partial<SqlTab>) {
    const next = createTab(tabs.length + 1, init);
    setTabs((prev) => [...prev, next]);
    setActiveTabId(next.id);
    return next;
  }

  async function closeTab(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const hasWork = tab.query.trim() && tab.query.trim() !== DEFAULT_QUERY;
    if (hasWork) {
      const ok = await confirmDialog({
        title: 'Close tab',
        description: `Close "${tab.title}"? Its query will be lost${tab.snippetId ? ' (the saved copy is kept)' : ''}.`,
        confirmText: 'Close tab',
        destructive: true,
      });
      if (!ok) return;
    }
    setRuns((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
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
    if (nextTitle) {
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: nextTitle } : t)));
    }
    setRenamingTabId(null);
    setRenameValue('');
  }

  /**
   * Run the active tab's query. `nav` is set when moving between pages of a
   * result: the query then runs again in a read-only transaction (a statement
   * that writes is refused, never repeated) and the first page's total is kept.
   */
  async function execute(opts: { page?: number; queryOverride?: string; nav?: boolean } = {}) {
    const tab = activeTab;
    const q = opts.queryOverride ?? tab?.query ?? '';
    if (!tab || !q.trim() || runningTabId) return;
    const page = opts.page ?? 1;
    const nav = !!opts.nav;
    const runId = newId();
    const controller = new AbortController();
    runRef.current = { tabId: tab.id, runId, controller };
    setRunningTabId(tab.id);
    if (!nav) setRun(tab.id, () => ({ result: null, error: null }));
    try {
      const data = await api.sql.execute(projectId, q, {
        page,
        limit: PAGE_SIZE,
        countTotal: !nav,
        readOnly: nav,
        maxRows: MAX_ROWS,
        compact: true,
        runId,
        signal: controller.signal,
      });
      setRun(tab.id, (prev) => ({
        result: data,
        error: null,
        executedQuery: q,
        total: nav ? prev.total : data.total,
        totalIsApprox: nav ? prev.totalIsApprox : data.totalIsApprox,
      }));
    } catch (err: any) {
      const message = controller.signal.aborted ? 'Query cancelled.' : err?.message || 'Query failed';
      setRun(tab.id, (prev) => ({ ...prev, error: message }));
      if (controller.signal.aborted) toast.info('Query cancelled');
      else toast.error(message);
    } finally {
      setRunningTabId(null);
      setCancelling(false);
      runRef.current = null;
    }
  }

  async function cancelRun() {
    const current = runRef.current;
    if (!current) return;
    setCancelling(true);
    try {
      const { cancelled } = await api.sql.cancel(projectId, current.runId);
      // The run may not have reached the database yet; stop waiting for it.
      if (!cancelled) current.controller.abort();
    } catch {
      current.controller.abort();
    }
  }

  function goToPage(page: number) {
    if (!run.executedQuery) return;
    void execute({ page, queryOverride: run.executedQuery, nav: true });
  }

  function formatQuery() {
    if (!query.trim()) return;
    try {
      const formatted = formatSql(query);
      updateActiveTab((t) => ({ ...t, query: formatted }));
    } catch {
      toast.error('Could not format this query');
    }
  }

  // ── Copy / download ───────────────────────────────────────────────────────

  function buildMarkdownTable(fields: { name: string }[] | undefined, rows: Record<string, unknown>[] | undefined): string {
    if (!fields?.length) return 'Query executed successfully.';
    const headers = fields.map((f) => f.name);
    const esc = (v: unknown) =>
      (v === null || v === undefined ? 'NULL' : formatCellValue(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return [
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      ...(rows ?? []).map((row) => `| ${headers.map((h) => esc(row[h])).join(' | ')} |`),
    ].join('\n');
  }

  function copyResultAsMarkdown() {
    if (!result) return;
    void navigator.clipboard.writeText(buildMarkdownTable(result.fields, result.rows));
    toast.success('Result copied as Markdown');
  }

  function copyResultAsJson() {
    if (!result) return;
    void navigator.clipboard.writeText(JSON.stringify(result.rows ?? [], null, 2));
    toast.success('Result copied as JSON');
  }

  /**
   * Every row of the result, not just the page on screen: a paged read is
   * fetched page by page (read-only, up to EXPORT_ROW_CAP rows).
   */
  async function collectAllRows(): Promise<{ fields: { name: string; dataTypeId: number }[]; rows: Record<string, unknown>[]; capped: boolean }> {
    if (!result?.fields?.length) return { fields: [], rows: [], capped: false };
    const executed = run.executedQuery;
    const knownTotal = run.total ?? null;
    const onePage =
      !result.paginated ||
      !executed ||
      (knownTotal !== null && !run.totalIsApprox && knownTotal <= (result.rows?.length ?? 0) && (result.page ?? 1) === 1);
    if (onePage) return { fields: result.fields, rows: result.rows ?? [], capped: false };

    const rows: Record<string, unknown>[] = [];
    const limit = 1000;
    for (let page = 1; rows.length < EXPORT_ROW_CAP; page++) {
      const data = await api.sql.execute(projectId, executed!, { page, limit, readOnly: true, compact: true });
      rows.push(...(data.rows ?? []));
      if ((data.rows?.length ?? 0) < limit) return { fields: result.fields, rows, capped: false };
    }
    return { fields: result.fields, rows: rows.slice(0, EXPORT_ROW_CAP), capped: true };
  }

  async function download(format: 'xlsx' | 'csv') {
    if (!result) return;
    const sets =
      result.resultSets && result.resultSets.length > 1
        ? result.resultSets.filter((rs) => rs.fields?.length)
        : null;
    if (!sets && !result.fields?.length) {
      toast.error('No tabular result to export');
      return;
    }
    setExporting(true);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tables = sets
        ? sets.map((rs, i) => ({ name: `Statement ${i + 1}`, fields: rs.fields ?? [], rows: rs.rows ?? [], capped: false }))
        : [{ name: 'SQL Result', ...(await collectAllRows()) }];
      if (format === 'xlsx') {
        const workbook = XLSX.utils.book_new();
        for (const t of tables) {
          const headers = t.fields.map((f) => f.name);
          const sheet = XLSX.utils.aoa_to_sheet([headers, ...t.rows.map((row) => headers.map((h) => exportCellValue(row[h])))]);
          XLSX.utils.book_append_sheet(workbook, sheet, t.name.slice(0, 31));
        }
        XLSX.writeFile(workbook, `sql-result-${stamp}.xlsx`);
      } else {
        const t = tables[tables.length - 1];
        const headers = t.fields.map((f) => f.name);
        const csv = [headers.map(csvField).join(','), ...t.rows.map((row) => headers.map((h) => csvField(row[h])).join(','))].join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `sql-result-${stamp}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
      const count = tables.reduce((n, t) => n + t.rows.length, 0);
      const capped = tables.some((t) => t.capped);
      toast.success(
        capped
          ? `Downloaded the first ${formatCount(EXPORT_ROW_CAP)} rows`
          : `Downloaded ${rowLabel(count)}`,
      );
    } catch (err: any) {
      toast.error(err?.message || 'Download failed');
    } finally {
      setExporting(false);
    }
  }

  // ── Saved queries ─────────────────────────────────────────────────────────

  async function loadSnippets() {
    try {
      setSnippets(await api.sql.listSnippets(projectId));
    } catch (err: any) {
      setSnippets([]);
      toast.error(err?.message || 'Could not load saved queries');
    }
  }

  async function saveQuery() {
    if (!activeTab || !query.trim()) return;
    try {
      if (activeTab.snippetId) {
        await api.sql.updateSnippet(activeTab.snippetId, { query });
        toast.success(`Saved "${activeTab.title}"`);
        return;
      }
      const name = await promptDialog({
        title: 'Save query',
        description: 'Saved queries are shared with everyone on the project’s team.',
        placeholder: 'Query name',
        defaultValue: activeTab.title,
        confirmText: 'Save',
      });
      if (!name?.trim()) return;
      const created = await api.sql.createSnippet(projectId, { name: name.trim(), query });
      updateActiveTab((t) => ({ ...t, title: created.name, snippetId: created.id }));
      setSnippets(null);
      toast.success(`Saved "${created.name}"`);
    } catch (err: any) {
      // The saved copy may have been deleted elsewhere: save it as a new one next time.
      if (err?.status === 404) updateActiveTab((t) => ({ ...t, snippetId: null }));
      toast.error(err?.message || 'Could not save the query');
    }
  }

  async function deleteSnippet(s: SqlSnippet) {
    const ok = await confirmDialog({
      title: 'Delete saved query',
      description: `Delete "${s.name}"? It is removed for the whole team.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.sql.deleteSnippet(s.id);
      setSnippets((prev) => (prev ?? []).filter((x) => x.id !== s.id));
      setTabs((prev) => prev.map((t) => (t.snippetId === s.id ? { ...t, snippetId: null } : t)));
      toast.success('Saved query deleted');
    } catch (err: any) {
      toast.error(err?.message || 'Could not delete the saved query');
    }
  }

  function openSnippet(s: SqlSnippet) {
    const existing = tabs.find((t) => t.snippetId === s.id);
    if (existing) setActiveTabId(existing.id);
    else addTab({ title: s.name, query: s.query, snippetId: s.id });
    setSnippetsOpen(false);
  }

  // ── History ───────────────────────────────────────────────────────────────

  async function openHistory() {
    setHistoryOpen(true);
    setHistory(null);
    try {
      setHistory(await api.sql.history(projectId, 100));
    } catch (err: any) {
      setHistory([]);
      toast.error(err?.message || 'Could not load query history');
    }
  }

  // ── Assistant ─────────────────────────────────────────────────────────────

  async function askAssistant() {
    const request = aiPrompt.trim();
    if (!request) return;
    setAiBusy(true);
    setAiReply(null);
    try {
      const tables = await api.projects
        .tables(projectId)
        .then((t) => t.map((x) => (x.schema && x.schema !== 'public' ? `${x.schema}.${x.name}` : x.name)))
        .catch(() => [] as string[]);
      const current = query.trim() && query.trim() !== DEFAULT_QUERY ? `\n\nCurrent query in the editor:\n\`\`\`sql\n${query}\n\`\`\`` : '';
      const message =
        'You are helping in the SQL editor of a PostgreSQL database. Answer with one SQL statement in a ```sql code block, ' +
        `followed by a one-sentence explanation.${tables.length ? `\nTables: ${tables.slice(0, 200).join(', ')}` : ''}${current}\n\nRequest: ${request}`;
      const { reply } = await api.ai.chat(message, [], { projectId, tables, page: 'sql-editor', mode: 'ask' });
      setAiReply(reply);
    } catch (err: any) {
      toast.error(err?.message || 'The assistant is not available right now');
    } finally {
      setAiBusy(false);
    }
  }

  const aiSql = aiReply ? extractSql(aiReply) : null;

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void execute();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      void saveQuery();
    } else if (e.shiftKey && e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      formatQuery();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const pageNo = result?.page ?? 1;
  const pageLimit = result?.limit ?? PAGE_SIZE;
  const knownTotal = run.total ?? null;
  const totalPages = knownTotal !== null ? Math.max(1, Math.ceil(knownTotal / pageLimit)) : null;
  const nextDisabled =
    running ||
    (result?.rows?.length ?? 0) < pageLimit ||
    (totalPages !== null && !run.totalIsApprox && pageNo >= totalPages);
  const filteredSnippets = (snippets ?? []).filter((s) =>
    !snippetFilter.trim() || `${s.name} ${s.query}`.toLowerCase().includes(snippetFilter.trim().toLowerCase()),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-md border bg-muted/30 p-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTabId(tab.id)}
            className={`inline-flex shrink-0 cursor-pointer items-center gap-2 rounded px-2.5 py-1 text-xs ${
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
                className="inline-flex max-w-[160px] items-center gap-1 truncate text-left"
                title="Double-click to rename"
              >
                {tab.snippetId && <BookMarked className="h-3 w-3 shrink-0 text-primary" aria-label="Saved query" />}
                <span className="truncate">{tab.title}</span>
                {runningTabId === tab.id && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
              className="rounded p-0.5 hover:bg-muted"
              aria-label={`Close ${tab.title}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => addTab()} aria-label="New tab">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {running ? (
          <Button size="sm" variant="destructive" onClick={() => void cancelRun()} disabled={cancelling}>
            {cancelling ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Square className="mr-2 h-4 w-4" />}
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={() => void execute()} disabled={!query.trim() || !!runningTabId}>
            <Play className="mr-2 h-4 w-4" />
            Run (Ctrl+Enter)
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={formatQuery} disabled={!query.trim()} title="Format (Shift+Alt+F)">
          <Wand2 className="mr-1.5 h-3.5 w-3.5" />
          Format
        </Button>
        <Button size="sm" variant="outline" onClick={() => void saveQuery()} disabled={!query.trim()} title="Save (Ctrl+S)">
          <Save className="mr-1.5 h-3.5 w-3.5" />
          {activeTab?.snippetId ? 'Save' : 'Save as…'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setSnippetsOpen(true);
            if (snippets === null) void loadSnippets();
          }}
        >
          <BookMarked className="mr-1.5 h-3.5 w-3.5" />
          Saved queries
        </Button>
        <Button size="sm" variant="outline" onClick={() => void openHistory()}>
          <History className="mr-1.5 h-3.5 w-3.5" />
          History
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAiOpen(true)}>
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          Ask AI
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => {
            updateActiveTab((t) => ({ ...t, query: '' }));
            if (activeTab) setRun(activeTab.id, () => ({ result: null, error: null }));
          }}
          disabled={running || (!query && !result && !error)}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Clear
        </Button>
      </div>

      <textarea
        ref={textareaRef}
        value={query}
        onChange={(e) => updateActiveTab((t) => ({ ...t, query: e.target.value }))}
        onKeyDown={handleKeyDown}
        className="h-[32vh] min-h-[200px] w-full shrink-0 resize-y rounded-md border bg-muted/30 p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        placeholder="SELECT * FROM ..."
        spellCheck={false}
        aria-label="SQL query"
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        {error && (
          <div className="flex shrink-0 items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <span className="max-h-40 flex-1 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{error}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
              onClick={() => {
                void navigator.clipboard.writeText(error);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              title="Copy error"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
        )}

        {running && !result && (
          <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Running…
          </div>
        )}

        {result && (
          <>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
              <div className="flex flex-wrap items-center gap-4">
                <span>
                  {result.resultSets && result.resultSets.length > 1
                    ? `${result.resultSets.length} statements`
                    : result.paginated && knownTotal !== null
                      ? `${formatCount(knownTotal)}${run.totalIsApprox ? '+' : ''} ${knownTotal === 1 && !run.totalIsApprox ? 'row' : 'rows'} · page ${formatCount(pageNo)}${totalPages !== null ? ` of ${formatCount(totalPages)}${run.totalIsApprox ? '+' : ''}` : ''}`
                      : `${rowLabel(result.rowCount ?? result.rows?.length ?? 0)}${result.paginated ? ` · page ${formatCount(pageNo)}` : ''}`}
                </span>
                <span>{result.duration}ms</span>
                {result.paginated && (
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="outline" size="sm" disabled={running || pageNo <= 1} onClick={() => goToPage(pageNo - 1)}>
                      Prev
                    </Button>
                    <Button type="button" variant="outline" size="sm" disabled={nextDisabled} onClick={() => goToPage(pageNo + 1)}>
                      Next
                    </Button>
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
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" disabled={exporting}>
                      {exporting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1.5 h-3.5 w-3.5" />}
                      Download
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void download('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void download('csv')}>CSV</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {result.truncated && (
              <div className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                Only the first {formatCount(result.maxRows ?? MAX_ROWS)} rows of a result are returned here. Add a LIMIT, or run a
                single SELECT on its own to page through every row.
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-auto">
              {result.resultSets && result.resultSets.length > 1 ? (
                // Multi-statement script: show every statement's output in order.
                <div className="space-y-4">
                  {result.resultSets.map((rs, i) => (
                    <div key={i} className="space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">
                        Statement {i + 1}
                        {rs.fields?.length
                          ? ` · ${rowLabel(rs.rows?.length ?? 0)}${rs.truncated ? ` (first ${formatCount(rs.rows?.length ?? 0)} shown)` : ''}`
                          : rs.rowCount != null
                            ? ` · ${rowLabel(rs.rowCount)} affected`
                            : ' · executed'}
                      </div>
                      <ResultTable fields={rs.fields} rows={rs.rows} />
                    </div>
                  ))}
                </div>
              ) : (
                <ResultTable fields={result.fields} rows={result.rows} />
              )}
            </div>
          </>
        )}
      </div>

      {/* Saved queries */}
      <Dialog open={snippetsOpen} onOpenChange={setSnippetsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Saved queries</DialogTitle>
            <DialogDescription>Shared with everyone on this project&rsquo;s team.</DialogDescription>
          </DialogHeader>
          <Input placeholder="Search saved queries…" value={snippetFilter} onChange={(e) => setSnippetFilter(e.target.value)} />
          <div className="max-h-[50vh] space-y-1 overflow-y-auto">
            {snippets === null ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filteredSnippets.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {snippets.length === 0 ? 'No saved queries yet. Use "Save as…" to keep one.' : 'No saved queries match.'}
              </p>
            ) : (
              filteredSnippets.map((s) => (
                <div key={s.id} className="flex items-start gap-2 rounded-md border p-2">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openSnippet(s)}>
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="line-clamp-2 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{s.query}</div>
                  </button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => void deleteSnippet(s)} aria-label={`Delete ${s.name}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* History */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Query history</DialogTitle>
            <DialogDescription>Your most recent statements in this project.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[55vh] space-y-1 overflow-y-auto">
            {history === null ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : history.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No queries yet.</p>
            ) : (
              history.map((h) => (
                <div key={h.id} className="flex items-start gap-2 rounded-md border p-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{new Date(h.createdAt).toLocaleString()}</span>
                      {h.error ? (
                        <span className="text-destructive">Failed</span>
                      ) : (
                        <span>{h.rowCount != null ? rowLabel(h.rowCount) : 'OK'}</span>
                      )}
                      {h.duration != null && <span>{h.duration}ms</span>}
                    </div>
                    <div className="line-clamp-3 whitespace-pre-wrap font-mono text-[11px] [overflow-wrap:anywhere]">{h.query}</div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      addTab({ query: h.query });
                      setHistoryOpen(false);
                    }}
                  >
                    Open
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Assistant */}
      <Dialog open={aiOpen} onOpenChange={(o) => { setAiOpen(o); if (!o) setAiReply(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Ask AI</DialogTitle>
            <DialogDescription>
              Describe the query you need, or ask to fix or explain the one in the editor. Nothing runs until you run it.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="e.g. Orders per customer in the last 30 days, highest first"
            rows={3}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void askAssistant();
              }
            }}
          />
          {aiReply && (
            <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm [overflow-wrap:anywhere]">
              {aiReply}
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            {aiSql && (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    addTab({ title: 'AI query', query: aiSql });
                    setAiOpen(false);
                  }}
                >
                  Open in new tab
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    updateActiveTab((t) => ({ ...t, query: aiSql }));
                    setAiOpen(false);
                  }}
                >
                  Replace editor content
                </Button>
              </>
            )}
            <Button onClick={() => void askAssistant()} disabled={aiBusy || !aiPrompt.trim()}>
              {aiBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Ask
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

