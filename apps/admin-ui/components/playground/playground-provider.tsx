'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  getPlaygroundDb,
  listPlaygroundTables,
  resetPlaygroundDb,
  runPlaygroundSql,
  type PlaygroundRunResult,
  type PlaygroundTable,
} from '@/lib/playground/engine';

export type PlaygroundSection = 'sql' | 'tables' | 'storage' | 'api' | 'logs';

export interface HistoryEntry {
  id: string;
  sql: string;
  ok: boolean;
  statusCode: number;
  durationMs: number;
  rowCount: number | null;
  at: number;
}

export interface LogEntry {
  id: string;
  level: 'info' | 'success' | 'error';
  message: string;
  at: number;
}

interface PlaygroundContextValue {
  status: 'loading' | 'ready' | 'error';
  initError: string | null;
  section: PlaygroundSection;
  setSection: (s: PlaygroundSection) => void;
  query: string;
  setQuery: (q: string) => void;
  running: boolean;
  result: PlaygroundRunResult | null;
  lastSql: string;
  history: HistoryEntry[];
  logs: LogEntry[];
  tables: PlaygroundTable[];
  refreshTables: () => Promise<void>;
  run: (sqlOverride?: string) => Promise<void>;
  loadIntoEditor: (sql: string, opts?: { run?: boolean; section?: PlaygroundSection }) => void;
  reset: () => Promise<void>;
  resetting: boolean;
}

const PlaygroundContext = createContext<PlaygroundContextValue | null>(null);

let _id = 0;
const nextId = () => `${Date.now()}-${_id++}`;

export function PlaygroundProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [initError, setInitError] = useState<string | null>(null);
  const [section, setSection] = useState<PlaygroundSection>('sql');
  const [query, setQuery] = useState('SELECT * FROM users;');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundRunResult | null>(null);
  const [lastSql, setLastSql] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tables, setTables] = useState<PlaygroundTable[]>([]);
  const [resetting, setResetting] = useState(false);

  const log = useCallback((level: LogEntry['level'], message: string) => {
    setLogs((prev) => [{ id: nextId(), level, message, at: Date.now() }, ...prev].slice(0, 200));
  }, []);

  const refreshTables = useCallback(async () => {
    try {
      setTables(await listPlaygroundTables());
    } catch {
      /* table introspection failures are non-fatal for the UI */
    }
  }, []);

  // Boot the in-browser database once on mount.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      try {
        await getPlaygroundDb();
        setStatus('ready');
        log('info', 'Sandbox database ready — seeded with 6 tables.');
        await refreshTables();
      } catch (err) {
        setStatus('error');
        setInitError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [log, refreshTables]);

  const run = useCallback(
    async (sqlOverride?: string) => {
      const sql = (sqlOverride ?? query).trim();
      if (!sql || status !== 'ready') return;
      setRunning(true);
      try {
        const res = await runPlaygroundSql(sql);
        setResult(res);
        setLastSql(sql);
        setHistory((prev) =>
          [
            {
              id: nextId(),
              sql,
              ok: res.ok,
              statusCode: res.statusCode,
              durationMs: res.durationMs,
              rowCount: res.rowCount,
              at: Date.now(),
            },
            ...prev,
          ].slice(0, 100),
        );
        if (res.ok) {
          log(
            'success',
            `${res.statusCode} · ${res.rowCount ?? 0} row(s) · ${res.durationMs}ms`,
          );
          // Writes/DDL can change the schema — keep the Table Browser honest.
          if (!/^\s*(SELECT|WITH)\b/i.test(sql)) await refreshTables();
        } else {
          log('error', `${res.statusCode} · ${res.error ?? 'error'}`);
        }
      } finally {
        setRunning(false);
      }
    },
    [query, status, log, refreshTables],
  );

  const loadIntoEditor = useCallback<PlaygroundContextValue['loadIntoEditor']>(
    (sql, opts) => {
      setQuery(sql);
      setSection(opts?.section ?? 'sql');
      if (opts?.run) void run(sql);
    },
    [run],
  );

  const reset = useCallback(async () => {
    setResetting(true);
    try {
      await resetPlaygroundDb();
      setResult(null);
      setLastSql('');
      log('info', 'Sandbox reset — sample data restored.');
      await refreshTables();
    } catch (err) {
      log('error', `Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResetting(false);
    }
  }, [log, refreshTables]);

  return (
    <PlaygroundContext.Provider
      value={{
        status,
        initError,
        section,
        setSection,
        query,
        setQuery,
        running,
        result,
        lastSql,
        history,
        logs,
        tables,
        refreshTables,
        run,
        loadIntoEditor,
        reset,
        resetting,
      }}
    >
      {children}
    </PlaygroundContext.Provider>
  );
}

export function usePlayground(): PlaygroundContextValue {
  const ctx = useContext(PlaygroundContext);
  if (!ctx) throw new Error('usePlayground must be used within a PlaygroundProvider');
  return ctx;
}
