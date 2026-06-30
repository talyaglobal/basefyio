'use client';

import { AlertTriangle, Database, HardDrive, Loader2, ScrollText, Table2, Terminal, Webhook } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePlayground, type PlaygroundSection } from './playground-provider';
import { SqlEditor } from './sql-editor';
import { ResponseViewer } from './response-viewer';
import { TableBrowser } from './table-browser';
import { RestExplorer } from './rest-explorer';
import { StorageBrowser } from './storage-browser';
import { LogsPanel } from './logs-panel';
import { ExampleQueries } from './example-queries';
import { QueryHistory } from './query-history';
import { Splitter } from './splitter';

const SECTIONS: { id: PlaygroundSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'tables', label: 'Tables', icon: Table2 },
  { id: 'sql', label: 'SQL', icon: Terminal },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'api', label: 'API', icon: Webhook },
  { id: 'logs', label: 'Logs', icon: ScrollText },
];

function BootGate({ children }: { children: React.ReactNode }) {
  const { status, initError } = usePlayground();
  if (status === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">Booting Postgres in your browser…</p>
          <p className="text-xs">PGlite (Postgres compiled to WebAssembly) · no signup, no server</p>
        </div>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertTriangle className="h-7 w-7 text-destructive" />
        <p className="text-sm font-medium">Couldn&apos;t start the sandbox database.</p>
        <p className="max-w-md text-xs text-muted-foreground">{initError}</p>
      </div>
    );
  }
  return <>{children}</>;
}

function SqlWorkspace() {
  const { result, running } = usePlayground();
  return (
    <div className="flex min-h-0 flex-1">
      {/* Examples + history */}
      <div className="hidden w-56 shrink-0 flex-col overflow-auto border-r p-2 md:flex">
        <ExampleQueries />
        <div className="my-2 border-t" />
        <QueryHistory />
      </div>
      {/* Editor | Response */}
      <Splitter
        left={
          <div className="flex min-h-0 flex-1 flex-col">
            <SqlEditor />
          </div>
        }
        right={
          <div className="flex min-h-0 flex-1 flex-col border-l">
            <ResponseViewer result={result} running={running} />
          </div>
        }
      />
    </div>
  );
}

export function PlaygroundLayout() {
  const { section, setSection } = usePlayground();
  return (
    <div className="flex min-h-0 flex-1">
      {/* Section rail */}
      <aside className="flex w-44 shrink-0 flex-col border-r bg-card">
        <div className="flex items-center gap-2 px-3 py-3 text-xs font-medium text-muted-foreground">
          <Database className="h-3.5 w-3.5" /> Sandbox
        </div>
        <nav className="space-y-0.5 px-2">
          {SECTIONS.map((s) => {
            const active = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
                )}
              >
                <s.icon className="h-4 w-4" />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto p-3 text-[11px] leading-relaxed text-muted-foreground">
          Real Postgres in WebAssembly. Everything runs locally in this tab.
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <BootGate>
          {section === 'sql' && <SqlWorkspace />}
          {section === 'tables' && <TableBrowser />}
          {section === 'storage' && <StorageBrowser />}
          {section === 'api' && <RestExplorer />}
          {section === 'logs' && <LogsPanel />}
        </BootGate>
      </main>
    </div>
  );
}
