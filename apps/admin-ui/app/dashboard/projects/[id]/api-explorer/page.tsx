'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TableInfo, ColumnInfo, ConnectionStrings } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Copy, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';

// ── helpers ────────────────────────────────────────────────

function exampleValue(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('uuid')) return '"a1b2c3d4-..."';
  if (t.includes('serial') || t === 'integer' || t === 'bigint' || t === 'smallint') return '1';
  if (t.includes('numeric') || t === 'real' || t === 'double precision') return '9.99';
  if (t === 'boolean') return 'true';
  if (t.includes('timestamp') || t === 'date') return '"2025-01-15T10:30:00Z"';
  if (t === 'time') return '"10:30:00"';
  if (t.includes('json')) return '{}';
  if (t === 'bytea') return '"\\\\x..."';
  return '"value"';
}

function buildExampleBody(columns: ColumnInfo[]): string {
  const pairs = columns
    .filter((c) => !(c.isPrimary && c.defaultValue))
    .slice(0, 6)
    .map((c) => `  "${c.name}": ${exampleValue(c.type)}`);
  return `{\n${pairs.join(',\n')}\n}`;
}

function copyText(text: string, label: string) {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copied`);
}

// ── method badge ───────────────────────────────────────────

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  POST: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  PATCH: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  DELETE: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
};

function MethodBadge({ method }: { method: string }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-bold font-mono ${METHOD_STYLES[method] ?? ''}`}>
      {method}
    </span>
  );
}

// ── endpoint card ──────────────────────────────────────────

function EndpointCard({
  method,
  url,
  description,
  headers,
  queryHint,
  body,
  curlCommand,
}: {
  method: string;
  url: string;
  description: string;
  headers: { key: string; value: string; secret?: boolean }[];
  queryHint?: string;
  body?: string;
  curlCommand: string;
}) {
  const [open, setOpen] = useState(method === 'GET');

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50 transition-colors rounded-lg"
      >
        <MethodBadge method={method} />
        <code className="flex-1 truncate text-sm text-foreground">{url}</code>
        <span className="text-xs text-muted-foreground hidden sm:block">{description}</span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="border-t px-4 py-3 space-y-3">
          {/* Headers */}
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Headers</span>
            <div className="mt-1 space-y-1">
              {headers.map((h) => (
                <div key={h.key} className="flex items-center gap-2 font-mono text-xs">
                  <span className="text-muted-foreground">{h.key}:</span>
                  <span className="truncate">{h.secret ? `${h.value.slice(0, 12)}...` : h.value}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0"
                    onClick={() => copyText(h.value, h.key)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Query hint */}
          {queryHint && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Query Filters</span>
              <pre className="mt-1 rounded-md bg-muted/50 p-2 text-xs overflow-x-auto whitespace-pre-wrap">{queryHint}</pre>
            </div>
          )}

          {/* Body */}
          {body && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Body</span>
              <pre className="mt-1 rounded-md bg-muted/50 p-2 text-xs overflow-x-auto">{body}</pre>
            </div>
          )}

          {/* Copy curl */}
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5"
              onClick={() => copyText(curlCommand, 'curl command')}
            >
              <Copy className="h-3 w-3" />
              Copy as curl
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── filter reference ───────────────────────────────────────

function FilterReference({ columns }: { columns: ColumnInfo[] }) {
  // Build examples from the selected table's real columns so they map to
  // something that actually exists; fall back to generic names if unknown.
  const any = columns[0]?.name || 'id';
  const textCol = columns.find((c) => /char|text|uuid|citext|name/i.test(c.type))?.name || any;
  const numCol = columns.find((c) => /int|numeric|decimal|real|double|serial|money/i.test(c.type))?.name || any;
  const eqCol = columns.find((c) => c.isPrimary)?.name || any;
  const dateCol = columns.find((c) => /date|time/i.test(c.type))?.name || any;
  const selectCols = columns.slice(0, 3).map((c) => c.name).join(',') || 'id';

  const filters = [
    { op: 'eq', example: `?${eqCol}=eq.5`, desc: 'Equal' },
    { op: 'neq', example: `?${textCol}=neq.value`, desc: 'Not equal' },
    { op: 'gt', example: `?${numCol}=gt.18`, desc: 'Greater than' },
    { op: 'gte', example: `?${numCol}=gte.18`, desc: 'Greater than or equal' },
    { op: 'lt', example: `?${numCol}=lt.100`, desc: 'Less than' },
    { op: 'lte', example: `?${numCol}=lte.100`, desc: 'Less than or equal' },
    { op: 'like', example: `?${textCol}=like.*abc*`, desc: 'Pattern match (case-sensitive)' },
    { op: 'ilike', example: `?${textCol}=ilike.*abc*`, desc: 'Pattern match (case-insensitive)' },
    { op: 'is', example: `?${textCol}=is.null`, desc: 'IS NULL / TRUE / FALSE' },
    { op: 'in', example: `?${textCol}=in.(a,b)`, desc: 'In list' },
  ];

  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b">
        <h3 className="text-sm font-semibold">Filter Reference</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Add filters as query parameters. Combine multiple with <code className="bg-muted px-1 rounded">&amp;</code>
        </p>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filters.map((f) => (
            <div key={f.op} className="flex items-start gap-2 text-xs">
              <code className="bg-muted px-1.5 py-0.5 rounded font-bold shrink-0 min-w-[40px] text-center">{f.op}</code>
              <div>
                <code className="text-muted-foreground">{f.example}</code>
                <span className="text-muted-foreground ml-1">- {f.desc}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t space-y-1 text-xs text-muted-foreground">
          <p><strong>Pagination:</strong> <code className="bg-muted px-1 rounded">?limit=20&amp;offset=0</code></p>
          <p><strong>Sort:</strong> <code className="bg-muted px-1 rounded">?order={dateCol}.desc</code></p>
          <p><strong>Select columns:</strong> <code className="bg-muted px-1 rounded">?select={selectCols}</code></p>
        </div>
      </div>
    </div>
  );
}

// ── main page ──────────────────────────────────────────────

export default function ApiExplorerPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [conn, setConn] = useState<ConnectionStrings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.projects.tables(projectId),
      api.projects.connect(projectId),
    ])
      .then(([t, c]) => {
        setTables(t.filter((tb) => tb.schema === 'public'));
        setConn(c);
        if (t.length > 0) setSelected(t[0].name);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    if (!selected) return;
    api.projects.columns(projectId, selected).then(setColumns).catch(() => {});
  }, [projectId, selected]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!conn) {
    return <p className="text-sm text-muted-foreground">Unable to load connection details.</p>;
  }

  const restUrl = conn.restUrl;
  const tableUrl = `${restUrl}/${selected}`;
  const body = buildExampleBody(columns);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">REST API Explorer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Interactive reference for your project&apos;s REST endpoints. Select a table, copy the commands and paste into your code.
        </p>
      </div>

      {/* Table selector + base URL */}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium shrink-0">Table</label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm min-w-[180px]"
          >
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.rowCount} rows)
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground shrink-0">Base URL:</span>
          <code className="truncate text-xs bg-muted px-2 py-1 rounded">{restUrl}</code>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={() => copyText(restUrl, 'REST URL')}>
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Warning for service key */}
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <strong>Security note:</strong> POST, PATCH, and DELETE examples use the <strong>service key</strong> (bypasses RLS).
          Use the <strong>anon key</strong> for client-side code and the service key only on the server.
        </div>
      </div>

      {/* Endpoints */}
      {selected && (
        <div className="space-y-3">
          {/* GET */}
          <EndpointCard
            method="GET"
            url={`${tableUrl}?select=*&limit=10`}
            description="Read rows"
            headers={[
              { key: 'apikey', value: conn.anonKey, secret: true },
            ]}
            queryHint={`?select=id,name,email\n?status=eq.active\n?order=created_at.desc&limit=20`}
            curlCommand={`curl '${tableUrl}?select=*&limit=10' \\\n  -H "apikey: ${conn.anonKey}"`}
          />

          {/* POST */}
          <EndpointCard
            method="POST"
            url={tableUrl}
            description="Insert rows"
            headers={[
              { key: 'apikey', value: conn.serviceKey, secret: true },
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Prefer', value: 'return=representation' },
            ]}
            body={body}
            curlCommand={`curl -X POST '${tableUrl}' \\\n  -H "apikey: ${conn.serviceKey}" \\\n  -H "Content-Type: application/json" \\\n  -H "Prefer: return=representation" \\\n  -d '${body.replace(/\n/g, '')}'`}
          />

          {/* PATCH */}
          <EndpointCard
            method="PATCH"
            url={`${tableUrl}?id=eq.1`}
            description="Update rows"
            headers={[
              { key: 'apikey', value: conn.serviceKey, secret: true },
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Prefer', value: 'return=representation' },
            ]}
            body={body}
            queryHint="Requires at least one filter to prevent full-table updates."
            curlCommand={`curl -X PATCH '${tableUrl}?id=eq.1' \\\n  -H "apikey: ${conn.serviceKey}" \\\n  -H "Content-Type: application/json" \\\n  -H "Prefer: return=representation" \\\n  -d '${body.replace(/\n/g, '')}'`}
          />

          {/* DELETE */}
          <EndpointCard
            method="DELETE"
            url={`${tableUrl}?id=eq.1`}
            description="Delete rows"
            headers={[
              { key: 'apikey', value: conn.serviceKey, secret: true },
            ]}
            queryHint="Requires at least one filter to prevent full-table deletes."
            curlCommand={`curl -X DELETE '${tableUrl}?id=eq.1' \\\n  -H "apikey: ${conn.serviceKey}"`}
          />
        </div>
      )}

      {/* Filter reference */}
      <FilterReference columns={columns} />
    </div>
  );
}
