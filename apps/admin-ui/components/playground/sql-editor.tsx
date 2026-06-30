'use client';

import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { Loader2, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePlayground } from './playground-provider';

export function SqlEditor() {
  const { query, setQuery, run, running, status } = usePlayground();

  // Keep the latest run() in a ref so the Monaco keybinding (registered once on
  // mount) always calls the current closure instead of a stale one.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const handleMount = useCallback<OnMount>((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void runRef.current();
    });
    editor.focus();
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">
          SQL Editor · <kbd className="rounded border px-1">⌘/Ctrl + Enter</kbd> to run
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => setQuery('')}
            disabled={running || !query}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Clear
          </Button>
          <Button
            size="sm"
            className="h-7"
            onClick={() => void run()}
            disabled={running || status !== 'ready' || !query.trim()}
          >
            {running ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            Run
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language="sql"
          theme="vs-dark"
          value={query}
          onChange={(v) => setQuery(v ?? '')}
          onMount={handleMount}
          loading={
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading editor…
            </div>
          }
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            padding: { top: 12, bottom: 12 },
            automaticLayout: true,
            tabSize: 2,
            renderLineHighlight: 'line',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        />
      </div>
    </div>
  );
}
