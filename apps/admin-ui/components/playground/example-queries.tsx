'use client';

import { Sparkles } from 'lucide-react';
import { EXAMPLE_QUERIES } from '@/lib/playground/examples';
import { usePlayground } from './playground-provider';

export function ExampleQueries() {
  const { loadIntoEditor } = usePlayground();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-1 pb-1 text-xs font-medium text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" /> Examples
      </div>
      {EXAMPLE_QUERIES.map((ex) => (
        <button
          key={ex.label}
          type="button"
          onClick={() => loadIntoEditor(ex.sql, { run: true })}
          className="w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <div className="font-medium">{ex.label}</div>
          <div className="text-xs text-muted-foreground">{ex.description}</div>
        </button>
      ))}
    </div>
  );
}
