'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { SqlResult } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Play, Loader2 } from 'lucide-react';

interface SqlEditorProps {
  projectId: string;
}

export function SqlEditor({ projectId }: SqlEditorProps) {
  const [query, setQuery] = useState('SELECT NOW();');
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function execute() {
    if (!query.trim()) return;

    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const data = await api.sql.execute(projectId, query);
      setResult(data);
    } catch (err: any) {
      setError(err.message);
      toast.error(err.message);
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      execute();
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="relative">
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          className="min-h-[200px] w-full resize-y rounded-md border bg-muted/30 p-4 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder="SELECT * FROM ..."
          spellCheck={false}
        />
        <div className="absolute bottom-3 right-3">
          <Button onClick={execute} disabled={running || !query.trim()} size="sm">
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
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <span>{result.rowCount ?? 0} rows</span>
            <span>{result.duration}ms</span>
          </div>

          <div className="overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  {result.fields?.map((field) => (
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
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {result.fields?.map((field) => (
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
        </div>
      )}
    </div>
  );
}
