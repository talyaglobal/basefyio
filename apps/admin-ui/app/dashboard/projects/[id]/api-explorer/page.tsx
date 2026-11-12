'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { TableInfo, ColumnInfo, ConnectionStrings, CollectionInfo } from '@/lib/types';
import { isPlatformEmbeddingTable } from '@/lib/embeddings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Copy, ChevronDown, ChevronRight, AlertTriangle, Play, Loader2 } from 'lucide-react';

// ── helpers ────────────────────────────────────────────────

/** A JSON literal of the column's type, for request bodies. */
function exampleValue(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('uuid')) return '"00000000-0000-0000-0000-000000000000"';
  if (t.includes('serial') || t === 'integer' || t === 'bigint' || t === 'smallint') return '1';
  if (t.includes('numeric') || t === 'real' || t === 'double precision') return '9.99';
  if (t === 'boolean') return 'true';
  if (t.includes('timestamp') || t === 'date') return '"2025-01-15T10:30:00Z"';
  if (t === 'time') return '"10:30:00"';
  if (t.includes('json')) return '{}';
  if (t === 'bytea') return '"\\\\x..."';
  return '"value"';
}

/** The same example as it appears in a URL filter (`id=eq.<value>`): no JSON quotes. */
function filterValue(type: string): string {
  return exampleValue(type).replace(/^"|"$/g, '');
}

/** The same example as a JavaScript / Python literal for SDK snippets. */
function codeValue(type: string): string {
  const v = exampleValue(type);
  return v.startsWith('"') ? `'${v.slice(1, -1)}'` : v;
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

/** Where the service key comes from in a snippet: an environment variable, never the key itself. */
const SERVICE_KEY_ENV = 'BASEFYIO_SERVICE_KEY';

type Lang = 'curl' | 'javascript' | 'sdk' | 'python';
const LANG_LABELS: Record<Lang, string> = {
  curl: 'curl',
  javascript: 'JavaScript',
  sdk: 'basefyio-js',
  python: 'Python',
};

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  /** `anon` puts the anon key in the snippet; `service` reads the service key from the environment. */
  key: 'anon' | 'service';
  prefer?: string;
  body?: string;
}

/** The same request as curl, fetch and Python, from one description. */
function requestSnippets(req: RequestSpec, anonKey: string): Omit<Record<Lang, string>, 'sdk'> {
  const keyShell = req.key === 'anon' ? anonKey : `$${SERVICE_KEY_ENV}`;
  const keyJs = req.key === 'anon' ? `'${anonKey}'` : `process.env.${SERVICE_KEY_ENV}`;
  const keyPy = req.key === 'anon' ? `"${anonKey}"` : `os.environ["${SERVICE_KEY_ENV}"]`;
  const oneLineBody = req.body?.replace(/\n\s*/g, ' ');

  const curl = [
    `curl -X ${req.method} '${req.url}'`,
    `  -H "apikey: ${keyShell}"`,
    ...(req.body ? ['  -H "Content-Type: application/json"'] : []),
    ...(req.prefer ? [`  -H "Prefer: ${req.prefer}"`] : []),
    ...(oneLineBody ? [`  -d '${oneLineBody}'`] : []),
  ].join(' \\\n');

  const jsHeaders = [
    `apikey: ${keyJs}`,
    ...(req.body ? [`'Content-Type': 'application/json'`] : []),
    ...(req.prefer ? [`Prefer: '${req.prefer}'`] : []),
  ];
  const javascript =
    `const res = await fetch('${req.url}', {\n` +
    `  method: '${req.method}',\n` +
    `  headers: { ${jsHeaders.join(', ')} },\n` +
    (req.body ? `  body: JSON.stringify(${req.body.replace(/\n/g, '\n  ')}),\n` : '') +
    `});\nconst result = await res.json();`;

  const pyHeaders = [
    `"apikey": ${keyPy}`,
    ...(req.prefer ? [`"Prefer": "${req.prefer}"`] : []),
  ];
  const python =
    (req.key === 'service' ? 'import os\n' : '') +
    `import requests\n\n` +
    `res = requests.request(\n` +
    `    "${req.method}",\n` +
    `    "${req.url}",\n` +
    `    headers={${pyHeaders.join(', ')}},\n` +
    (req.body ? `    json=${req.body.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\n/g, '\n    ')},\n` : '') +
    `)\nprint(res.status_code, res.text)`;

  return { curl, javascript, python };
}

// ── method badge ───────────────────────────────────────────

const METHOD_STYLES: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  POST: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  PATCH: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  PUT: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400',
  DELETE: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
};

function MethodBadge({ method }: { method: string }) {
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-bold font-mono ${METHOD_STYLES[method] ?? ''}`}>
      {method}
    </span>
  );
}

// ── code tabs ──────────────────────────────────────────────

function CodeTabs({ snippets }: { snippets: Record<Lang, string> }) {
  const [lang, setLang] = useState<Lang>('curl');
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex max-w-full overflow-x-auto rounded-md border bg-muted/40 p-0.5" role="tablist" aria-label="Code language">
          {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={lang === l}
              onClick={() => setLang(l)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                lang === l ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {LANG_LABELS[l]}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-xs gap-1.5 shrink-0"
          onClick={() => copyText(snippets[lang], `${LANG_LABELS[lang]} snippet`)}
        >
          <Copy className="h-3 w-3" />
          Copy
        </Button>
      </div>
      <pre className="mt-2 rounded-md bg-muted/50 p-3 text-xs overflow-x-auto">{snippets[lang]}</pre>
    </div>
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
  response,
  snippets,
  tryIt,
}: {
  method: string;
  url: string;
  description: string;
  headers: { key: string; value: string; secret?: boolean }[];
  queryHint?: string;
  body?: string;
  response: string;
  snippets: Record<Lang, string>;
  tryIt?: { baseUrl: string; defaultQuery: string; anonKey: string };
}) {
  const [open, setOpen] = useState(method === 'GET');

  return (
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
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
                    aria-label={`Copy ${h.key}`}
                    onClick={() => copyText(h.value, h.key)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {queryHint && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Query</span>
              <pre className="mt-1 rounded-md bg-muted/50 p-2 text-xs overflow-x-auto whitespace-pre-wrap">{queryHint}</pre>
            </div>
          )}

          {body && (
            <div>
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Body</span>
              <pre className="mt-1 rounded-md bg-muted/50 p-2 text-xs overflow-x-auto">{body}</pre>
            </div>
          )}

          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Response</span>
            <pre className="mt-1 rounded-md bg-muted/50 p-2 text-xs overflow-x-auto whitespace-pre-wrap">{response}</pre>
          </div>

          <CodeTabs snippets={snippets} />

          {tryIt && <TryIt {...tryIt} />}
        </div>
      )}
    </div>
  );
}

// ── try it ─────────────────────────────────────────────────

/**
 * Send a read from this page, with the anon key — so the answer is exactly
 * what a browser app with that key gets, row-level security included. Only
 * reads: nothing here can change data.
 */
function TryIt({ baseUrl, defaultQuery, anonKey }: { baseUrl: string; defaultQuery: string; anonKey: string }) {
  const [query, setQuery] = useState(defaultQuery);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ status: number; ms: number; range: string | null; body: string } | null>(null);

  useEffect(() => {
    setQuery(defaultQuery);
    setResult(null);
  }, [defaultQuery, baseUrl]);

  const run = async () => {
    setRunning(true);
    const started = performance.now();
    try {
      const qs = query.trim().replace(/^\?/, '');
      const res = await fetch(`${baseUrl}${qs ? `?${qs}` : ''}`, { headers: { apikey: anonKey } });
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // not JSON (e.g. CSV): show as it came
      }
      setResult({
        status: res.status,
        ms: Math.round(performance.now() - started),
        range: res.headers.get('content-range'),
        body: pretty.length > 20_000 ? `${pretty.slice(0, 20_000)}\n… (truncated)` : pretty,
      });
    } catch (err: unknown) {
      setResult({
        status: 0,
        ms: Math.round(performance.now() - started),
        range: null,
        body: err instanceof Error ? `Request failed: ${err.message}` : 'Request failed',
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Try it</span>
        <span className="text-[11px] text-muted-foreground">Runs with the anon key, so row-level security applies</span>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">?</span>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run();
            }}
            aria-label="Query string"
            className="h-8 font-mono text-xs"
          />
        </div>
        <Button size="sm" className="h-8 gap-1.5" onClick={run} disabled={running}>
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          Send
        </Button>
      </div>
      {result && (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span className={result.status >= 200 && result.status < 300 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
              {result.status ? `HTTP ${result.status}` : 'No response'}
            </span>
            <span>{result.ms} ms</span>
            {result.range && <span>Content-Range: {result.range}</span>}
          </div>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted/50 p-2 text-xs">{result.body}</pre>
        </div>
      )}
    </div>
  );
}

// ── filter reference ───────────────────────────────────────

function FilterReference({ columns }: { columns: ColumnInfo[] }) {
  // Build examples from the selected table's real columns so they map to
  // something that actually exists; fall back to generic names if unknown.
  const first = columns[0];
  const any = first?.name || 'id';
  const textCol = columns.find((c) => /char|text|citext|name/i.test(c.type))?.name || any;
  const numCol = columns.find((c) => /int|numeric|decimal|real|double|serial|money/i.test(c.type))?.name || any;
  const pk = columns.find((c) => c.isPrimary) ?? first;
  const eqCol = pk?.name || any;
  const eqVal = pk ? filterValue(pk.type) : '1';
  const orderCol = columns.find((c) => /date|time/i.test(c.type))?.name || any;
  const selectCols = columns.slice(0, 3).map((c) => c.name).join(',') || 'id';

  const filters = [
    { op: 'eq', example: `?${eqCol}=eq.${eqVal}`, desc: 'Equal' },
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
              <div className="min-w-0">
                <code className="text-muted-foreground break-all">{f.example}</code>
                <span className="text-muted-foreground ml-1">- {f.desc}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t space-y-1 text-xs text-muted-foreground">
          <p><strong>Pagination:</strong> <code className="bg-muted px-1 rounded">?limit=20&amp;offset=0</code> — at most 1000 rows per request; the <code className="bg-muted px-1 rounded">Content-Range</code> header shows the range returned and the total.</p>
          <p><strong>Sort:</strong> <code className="bg-muted px-1 rounded">?order={orderCol}.desc</code> (add <code className="bg-muted px-1 rounded">.nullsfirst</code> / <code className="bg-muted px-1 rounded">.nullslast</code> to place NULLs)</p>
          <p><strong>Select columns:</strong> <code className="bg-muted px-1 rounded">?select={selectCols}</code></p>
          <p><strong>Exact total:</strong> header <code className="bg-muted px-1 rounded">Prefer: count=exact</code> — without it, totals above 10,000 rows are estimates.</p>
        </div>
      </div>
    </div>
  );
}

// ── endpoints for a table ──────────────────────────────────

function TableEndpoints({
  table,
  columns,
  conn,
}: {
  table: string;
  columns: ColumnInfo[];
  conn: ConnectionStrings;
}) {
  const tableUrl = `${conn.restUrl}/${table}`;
  const body = buildExampleBody(columns);
  const pk = columns.find((c) => c.isPrimary) ?? columns[0];
  const pkName = pk?.name ?? 'id';
  const pkFilter = `${pkName}=eq.${pk ? filterValue(pk.type) : '1'}`;
  const pkCode = pk ? codeValue(pk.type) : '1';
  // JSON keys that are valid JavaScript identifiers lose their quotes in the SDK snippet.
  const sdkBody = body.replace(/"([A-Za-z_$][\w$]*)":/g, '$1:').replace(/\n/g, '\n  ');
  const textCol = columns.find((c) => /char|text|citext/i.test(c.type))?.name;
  const readQuery = `select=${columns.slice(0, 3).map((c) => c.name).join(',') || '*'}&limit=10`;

  const anon = { key: 'apikey', value: conn.anonKey, secret: true };
  const service = { key: 'apikey', value: conn.serviceKey, secret: true };
  const json = { key: 'Content-Type', value: 'application/json' };

  const get = requestSnippets({ method: 'GET', url: `${tableUrl}?${readQuery}`, key: 'anon' }, conn.anonKey);
  const post = requestSnippets(
    { method: 'POST', url: tableUrl, key: 'service', prefer: 'return=representation', body },
    conn.anonKey,
  );
  const upsertUrl = `${tableUrl}?on_conflict=${pkName}`;
  const upsert = requestSnippets(
    { method: 'POST', url: upsertUrl, key: 'service', prefer: 'resolution=merge-duplicates,return=representation', body },
    conn.anonKey,
  );
  const patch = requestSnippets(
    { method: 'PATCH', url: `${tableUrl}?${pkFilter}`, key: 'service', prefer: 'return=representation', body },
    conn.anonKey,
  );
  const del = requestSnippets({ method: 'DELETE', url: `${tableUrl}?${pkFilter}`, key: 'service' }, conn.anonKey);

  const writeResponse =
    '{ "count": 1 }  — or, with Prefer: return=representation, the rows themselves: [ { … } ]\n' +
    'Writes do not use the { data, count } envelope of a read.';

  return (
    <div className="space-y-3">
      <EndpointCard
        method="GET"
        url={`${tableUrl}?${readQuery}`}
        description="Read rows"
        headers={[anon]}
        queryHint={[
          `?select=${columns.slice(0, 3).map((c) => c.name).join(',') || 'id'}`,
          `?${pkFilter}`,
          textCol ? `?${textCol}=ilike.*abc*&order=${pkName}.desc&limit=20` : `?order=${pkName}.desc&limit=20`,
        ].join('\n')}
        response={'{ "data": [ { … } ], "count": 42 }\nHeader Content-Range: 0-9/42'}
        snippets={{ ...get, sdk: `const { data, error } = await bf.from('${table}').select('*').limit(10);` }}
        tryIt={{ baseUrl: tableUrl, defaultQuery: readQuery, anonKey: conn.anonKey }}
      />
      <EndpointCard
        method="POST"
        url={tableUrl}
        description="Insert rows"
        headers={[service, json, { key: 'Prefer', value: 'return=representation' }]}
        body={body}
        queryHint="Send one object or an array of objects."
        response={writeResponse}
        snippets={{ ...post, sdk: `const { data, error } = await bf.from('${table}').insert(${sdkBody});` }}
      />
      <EndpointCard
        method="POST"
        url={upsertUrl}
        description="Upsert rows"
        headers={[service, json, { key: 'Prefer', value: 'resolution=merge-duplicates,return=representation' }]}
        body={body}
        queryHint={`Inserts, or updates the row whose ${pkName} already exists. on_conflict may name another unique column; resolution=ignore-duplicates keeps existing rows.`}
        response={writeResponse}
        snippets={{ ...upsert, sdk: `const { data, error } = await bf.from('${table}').upsert(${sdkBody}, { onConflict: '${pkName}' });` }}
      />
      <EndpointCard
        method="PATCH"
        url={`${tableUrl}?${pkFilter}`}
        description="Update rows"
        headers={[service, json, { key: 'Prefer', value: 'return=representation' }]}
        body={body}
        queryHint="Requires at least one filter to prevent full-table updates."
        response={writeResponse}
        snippets={{ ...patch, sdk: `const { data, error } = await bf.from('${table}').update(${sdkBody}).eq('${pkName}', ${pkCode});` }}
      />
      <EndpointCard
        method="DELETE"
        url={`${tableUrl}?${pkFilter}`}
        description="Delete rows"
        headers={[service]}
        queryHint="Requires at least one filter to prevent full-table deletes."
        response={writeResponse}
        snippets={{ ...del, sdk: `const { error } = await bf.from('${table}').delete().eq('${pkName}', ${pkCode});` }}
      />
    </div>
  );
}

// ── endpoints for a collection ─────────────────────────────

function CollectionEndpoints({ name, conn }: { name: string; conn: ConnectionStrings }) {
  const base = `${conn.restUrl}/collections/${name}`;
  const doc = '{\n  "title": "Hello",\n  "status": "draft"\n}';
  const sdkDoc = "{ title: 'Hello', status: 'draft' }";
  const listQuery = 'filter={"status":"draft"}&limit=10';
  const docUrl = `${base}/<document-id>`;
  const docShape = '{ "id": "…", "data": { … }, "created_at": "…", "updated_at": "…" }';
  const docWrite = '{ "count": 1 }  — or, with Prefer: return=representation, the document(s) written';

  const anon = { key: 'apikey', value: conn.anonKey, secret: true };
  const service = { key: 'apikey', value: conn.serviceKey, secret: true };
  const json = { key: 'Content-Type', value: 'application/json' };

  const list = requestSnippets({ method: 'GET', url: `${base}?${listQuery}`, key: 'anon' }, conn.anonKey);
  const insert = requestSnippets({ method: 'POST', url: base, key: 'service', prefer: 'return=representation', body: doc }, conn.anonKey);
  const getOne = requestSnippets({ method: 'GET', url: docUrl, key: 'anon' }, conn.anonKey);
  const patch = requestSnippets({ method: 'PATCH', url: docUrl, key: 'service', body: '{\n  "status": "published"\n}' }, conn.anonKey);
  const put = requestSnippets({ method: 'PUT', url: docUrl, key: 'service', body: doc }, conn.anonKey);
  const del = requestSnippets({ method: 'DELETE', url: docUrl, key: 'service' }, conn.anonKey);

  return (
    <div className="space-y-3">
      <EndpointCard
        method="GET"
        url={`${base}?${listQuery}`}
        description="Find documents"
        headers={[anon]}
        queryHint={'?filter={"views":{"$gte":100}}\n?sort={"createdAt":-1}&limit=20&offset=0'}
        response={`{ "data": [ ${docShape} ], "count": 42 }`}
        snippets={{ ...list, sdk: `const { data, error } = await bf.collection('${name}').find({ status: 'draft' }).limit(10);` }}
        tryIt={{ baseUrl: base, defaultQuery: 'limit=10', anonKey: conn.anonKey }}
      />
      <EndpointCard
        method="POST"
        url={base}
        description="Insert documents"
        headers={[service, json]}
        body={doc}
        response={docWrite}
        snippets={{ ...insert, sdk: `const { data, error } = await bf.collection('${name}').insert(${sdkDoc});` }}
      />
      <EndpointCard
        method="GET"
        url={docUrl}
        description="Get one document"
        headers={[anon]}
        response={docShape}
        snippets={{ ...getOne, sdk: `const { data, error } = await bf.collection('${name}').findById(id);` }}
      />
      <EndpointCard
        method="PATCH"
        url={docUrl}
        description="Update fields"
        headers={[service, json]}
        body={'{\n  "status": "published"\n}'}
        response={docWrite}
        snippets={{ ...patch, sdk: `const { data, error } = await bf.collection('${name}').updateById(id, { status: 'published' });` }}
      />
      <EndpointCard
        method="PUT"
        url={docUrl}
        description="Replace a document"
        headers={[service, json]}
        body={doc}
        response={docWrite}
        snippets={{ ...put, sdk: `const { data, error } = await bf.collection('${name}').replaceById(id, ${sdkDoc});` }}
      />
      <EndpointCard
        method="DELETE"
        url={docUrl}
        description="Delete a document"
        headers={[service]}
        response={docWrite}
        snippets={{ ...del, sdk: `const { error } = await bf.collection('${name}').deleteById(id);` }}
      />
    </div>
  );
}

// ── main page ──────────────────────────────────────────────

/** The selector's value: `table:<name>` or `collection:<name>`. */
type Resource = { kind: 'table' | 'collection'; name: string };

function parseResource(value: string): Resource | null {
  const i = value.indexOf(':');
  if (i < 0) return null;
  const kind = value.slice(0, i);
  if (kind !== 'table' && kind !== 'collection') return null;
  return { kind, name: value.slice(i + 1) };
}

export default function ApiExplorerPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [selected, setSelected] = useState('');
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [conn, setConn] = useState<ConnectionStrings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.projects.tables(projectId),
      api.projects.connect(projectId),
      // A project without document collections answers with none (or an error); either way, no group.
      api.projects.listCollections(projectId).catch(() => [] as CollectionInfo[]),
    ])
      .then(([t, c, cols]) => {
        // The embedding tables pgvector creates are served by the Embeddings
        // API, not as REST resources of the project's own schema.
        const own = t.filter((tb) => tb.schema === 'public' && !isPlatformEmbeddingTable(tb.name, tb.schema));
        setTables(own);
        setCollections(Array.isArray(cols) ? cols : []);
        setConn(c);
        // The first entry of what the selector lists — so the selector and
        // every URL below always name the same resource.
        if (own.length > 0) setSelected(`table:${own[0].name}`);
        else if (Array.isArray(cols) && cols.length > 0) setSelected(`collection:${cols[0].name}`);
      })
      .catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  const resource = parseResource(selected);

  useEffect(() => {
    setColumns([]);
    if (!resource || resource.kind !== 'table') return;
    api.projects.columns(projectId, resource.name).then(setColumns).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const apiUrl = restUrl.replace(/\/api\/rest\/v1\/?$/, '');
  const sdkSetup =
    `import { createClient } from 'basefyio-js';\n\n` +
    `// In the browser: the anon key. On a server: process.env.${SERVICE_KEY_ENV}.\n` +
    `const bf = createClient({\n  apiUrl: '${apiUrl}',\n  projectId: '${projectId}',\n  apiKey: '${conn.anonKey}',\n});`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">REST API Explorer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Reference for your project&apos;s REST endpoints. Pick a table or collection, copy a snippet in the language you use, or try a read right here.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="flex items-center gap-2 min-w-0">
          <label htmlFor="api-explorer-resource" className="text-sm font-medium shrink-0">Resource</label>
          <select
            id="api-explorer-resource"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm min-w-0 sm:min-w-[220px] max-w-full"
          >
            {tables.length > 0 && (
              <optgroup label="Tables">
                {tables.map((t) => (
                  <option key={`table:${t.name}`} value={`table:${t.name}`}>
                    {t.name} ({t.rowCount} rows)
                  </option>
                ))}
              </optgroup>
            )}
            {collections.length > 0 && (
              <optgroup label="Collections">
                {collections.map((c) => (
                  <option key={`collection:${c.name}`} value={`collection:${c.name}`}>
                    {c.name} ({c.documentCount} documents)
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground shrink-0">Base URL:</span>
          <code className="truncate text-xs bg-muted px-2 py-1 rounded">{restUrl}</code>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label="Copy REST URL" onClick={() => copyText(restUrl, 'REST URL')}>
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        <div>
          <strong>Security note:</strong> write examples use the <strong>service key</strong> (bypasses row-level security).
          The snippets read it from the <code>{SERVICE_KEY_ENV}</code> environment variable rather than containing it — copy the key
          from the header row into your server&apos;s environment. Use the <strong>anon key</strong> in client-side code.
        </div>
      </div>

      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">basefyio-js setup</summary>
        <div className="border-t px-4 py-3">
          <pre className="rounded-md bg-muted/50 p-3 text-xs overflow-x-auto">{sdkSetup}</pre>
          <div className="mt-2 flex justify-end">
            <Button variant="outline" size="sm" className="text-xs gap-1.5" onClick={() => copyText(sdkSetup, 'Setup snippet')}>
              <Copy className="h-3 w-3" />
              Copy
            </Button>
          </div>
        </div>
      </details>

      {!resource && (
        <p className="text-sm text-muted-foreground">This project has no tables or collections yet.</p>
      )}

      {resource?.kind === 'table' && (
        <TableEndpoints table={resource.name} columns={columns} conn={conn} />
      )}
      {resource?.kind === 'collection' && <CollectionEndpoints name={resource.name} conn={conn} />}

      {resource?.kind === 'table' && <FilterReference columns={columns} />}
    </div>
  );
}
