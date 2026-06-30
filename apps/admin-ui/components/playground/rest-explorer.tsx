'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import type { PlaygroundRunResult } from '@/lib/playground/engine';
import { sqlExecuteRequest, toCurl, type RestRequest } from '@/lib/playground/rest';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './copy-button';
import { usePlayground } from './playground-provider';

function MethodBadge({ method }: { method: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono',
        method === 'GET' ? 'border-sky-500/40 text-sky-400' : 'border-emerald-500/40 text-emerald-400',
      )}
    >
      {method}
    </Badge>
  );
}

function Section({
  title,
  copy,
  children,
}: {
  title: string;
  copy?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {copy !== undefined && <CopyButton value={copy} />}
      </div>
      {children}
    </div>
  );
}

export function RestRequestView({
  request,
  response,
}: {
  request: RestRequest;
  response?: PlaygroundRunResult | null;
}) {
  const [tab, setTab] = useState<'rest' | 'sdk' | 'curl'>('rest');
  const curl = useMemo(() => toCurl(request), [request]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MethodBadge method={request.method} />
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/30 px-2 py-1 text-xs">
          {request.path}
        </code>
      </div>

      <div className="flex rounded-md border p-0.5 text-xs">
        {(['rest', 'sdk', 'curl'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              'flex-1 rounded px-2 py-1 uppercase tracking-wide transition-colors',
              tab === t ? 'bg-secondary font-medium' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t === 'rest' ? 'HTTP' : t === 'sdk' ? 'SDK' : 'cURL'}
          </button>
        ))}
      </div>

      {tab === 'rest' && (
        <div className="space-y-4">
          <Section title="Headers">
            <pre className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
              {Object.entries(request.headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')}
            </pre>
          </Section>
          {request.body !== undefined && (
            <Section title="Request body" copy={JSON.stringify(request.body, null, 2)}>
              <pre className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
                {JSON.stringify(request.body, null, 2)}
              </pre>
            </Section>
          )}
        </div>
      )}

      {tab === 'sdk' && (
        <Section title="@basefyio/sdk" copy={request.sdk}>
          <pre className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
            {request.sdk}
          </pre>
        </Section>
      )}

      {tab === 'curl' && (
        <Section title="cURL" copy={curl}>
          <pre className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
            {curl}
          </pre>
        </Section>
      )}

      {response && (
        <Section
          title={`Response · ${response.statusCode}`}
          copy={response.ok ? JSON.stringify(response.rows, null, 2) : response.error}
        >
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
            {response.ok
              ? JSON.stringify(response.rows.slice(0, 50), null, 2)
              : response.error}
          </pre>
        </Section>
      )}
    </div>
  );
}

/** Wired to the last SQL run — the dedicated "API" section of the Playground. */
export function RestExplorer() {
  const { lastSql, query, result } = usePlayground();
  const request = useMemo(() => sqlExecuteRequest((lastSql || query).trim() || 'SELECT 1;'), [lastSql, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">REST Explorer</h2>
        <p className="text-xs text-muted-foreground">
          The exact request the hosted basefyio API would receive for your last SQL operation.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <RestRequestView request={request} response={result} />
      </div>
    </div>
  );
}
