'use client';

import { cn } from '@/lib/utils';
import { usePlayground } from './playground-provider';

function ts(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

export function LogsPanel() {
  const { logs } = usePlayground();
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Logs</h2>
        <p className="text-xs text-muted-foreground">
          Every sandbox operation, newest first. Mirrors the platform&apos;s SQL activity feed.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs">
        {logs.length === 0 ? (
          <p className="text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-3">
                <span className="shrink-0 text-muted-foreground/70">{ts(l.at)}</span>
                <span
                  className={cn(
                    'shrink-0 uppercase',
                    l.level === 'error'
                      ? 'text-destructive'
                      : l.level === 'success'
                        ? 'text-emerald-400'
                        : 'text-sky-400',
                  )}
                >
                  {l.level}
                </span>
                <span className="break-all">{l.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
