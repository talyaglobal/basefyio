'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { SqlEditor } from '@/components/sql-editor';
import { QueryEditor } from '@/components/query-editor';
import { useProject } from '@/contexts/project-context';

type QueryPageMode = 'js' | 'sql';

export default function SqlPage() {
  const { id } = useParams<{ id: string }>();
  const { project } = useProject();
  const isNoSql = project?.databaseType === 'NOSQL';
  const modeStorageKey = `basefyio_query_mode_${id}`;
  const [mode, setMode] = useState<QueryPageMode>('js');

  useEffect(() => {
    if (!isNoSql) return;
    try {
      const stored = localStorage.getItem(modeStorageKey);
      if (stored === 'js' || stored === 'sql') setMode(stored);
    } catch {
      // Ignore storage access errors; keep the default mode.
    }
  }, [isNoSql, modeStorageKey]);

  function changeMode(next: QueryPageMode) {
    setMode(next);
    try {
      localStorage.setItem(modeStorageKey, next);
    } catch {
      // Ignore storage access errors.
    }
  }

  if (!isNoSql) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <h1 className="shrink-0 text-2xl font-bold tracking-tight">SQL Editor</h1>
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card p-3">
          <SqlEditor projectId={id} />
        </div>
      </div>
    );
  }

  const segment = (m: QueryPageMode, label: string) => (
    <button
      key={m}
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => changeMode(m)}
      className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
        mode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Query</h1>
        <div
          className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-0.5"
          role="radiogroup"
          aria-label="Query mode"
        >
          {segment('js', 'JS Query')}
          {segment('sql', 'SQL')}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card p-3">
        {mode === 'js' ? <QueryEditor projectId={id} /> : <SqlEditor projectId={id} />}
      </div>
    </div>
  );
}
