/**
 * The reference manual under docs/ against the controllers in the tree.
 *
 * (a) Every route a page names (`METHOD /api/...`) must exist — always a hard
 *     failure, so renaming or removing a documented route breaks CI until the
 *     page follows.
 * (b) Every route of a mapped controller should appear somewhere in the manual.
 *     Reported as a warning; a hard failure only with DOCS_STRICT=1.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RouteEntry, extractDocumentedRoutes, extractRoutes, routeKey } from './route-inventory';

const ROOT = path.resolve(__dirname, '../../../..');
const API_SRC = path.join(ROOT, 'apps/platform-api/src');
const M = 'apps/platform-api/src/modules';

/** Local-only or non-manual Markdown that is never checked. */
const IGNORED_DOCS = new Set(['docs/scoreboard.md']);

interface DocMapEntry {
  doc: string;
  controllers: string[];
  /** Routes deliberately left out of the public manual, with the reason in a comment. */
  excluded?: RegExp[];
}

const DOC_MAP: DocMapEntry[] = [
  { doc: 'docs/reference/auth-api.md', controllers: [`${M}/projects/project-sdk-auth.controller.ts`, `${M}/projects/project-oauth-callback.controller.ts`] },
  { doc: 'docs/reference/rest-api.md', controllers: [`${M}/projects/public-api.controller.ts`] },
  { doc: 'docs/reference/collections-api.md', controllers: [`${M}/projects/public-collection-api.controller.ts`, `${M}/projects/collection.controller.ts`] },
  { doc: 'docs/reference/storage-api.md', controllers: [`${M}/storage/storage.controller.ts`, `${M}/storage/storage-policy.controller.ts`, `${M}/storage/upload-session.controller.ts`] },
  { doc: 'docs/reference/sql-api.md', controllers: [`${M}/sql/sql.controller.ts`] },
  { doc: 'docs/REALTIME_API.md', controllers: [`${M}/realtime-data/realtime-data.controller.ts`] },
  { doc: 'docs/reference/embeddings-api.md', controllers: [`${M}/tenant-embedding/tenant-embedding-public.controller.ts`, `${M}/tenant-embedding/tenant-embedding.controller.ts`, `${M}/tenant-embedding/ai-disclosure.controller.ts`] },
  { doc: 'docs/reference/rag-api.md', controllers: [`${M}/rag/rag.controller.ts`] },
  { doc: 'docs/reference/flows-api.md', controllers: [`${M}/flows/flows.controller.ts`] },
  { doc: 'docs/reference/data-engine-api.md', controllers: [`${M}/data-engine/data-engine.controller.ts`, `${M}/data-query/data-query.controller.ts`, `${M}/data-structures/data-structures.controller.ts`] },
  {
    doc: 'docs/reference/project-admin-api.md',
    controllers: [
      `${M}/projects/projects.controller.ts`,
      `${M}/projects/project-data.controller.ts`,
      `${M}/projects/project-database.controller.ts`,
      `${M}/projects/project-policies.controller.ts`,
      `${M}/projects/backups/project-backups.controller.ts`,
      `${M}/projects/branches/project-branches.controller.ts`,
    ],
  },
  { doc: 'docs/reference/project-users-api.md', controllers: [`${M}/projects/project-auth.controller.ts`] },
  {
    doc: 'docs/reference/billing-api.md',
    controllers: [`${M}/billing/billing.controller.ts`],
    // Operator console and the Stripe webhook are not a customer contract.
    excluded: [/^\w+ \/api\/billing\/management\//, /^POST \/api\/billing\/webhook$/],
  },
  { doc: 'docs/guides/health-and-metrics.md', controllers: [`${M}/health/health.controller.ts`, `${M}/health/metrics.controller.ts`] },
  { doc: 'docs/API_TOKENS.md', controllers: [`${M}/api-tokens/api-tokens.controller.ts`] },
];

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

function controllerInventory(): Map<string, RouteEntry[]> {
  const byFile = new Map<string, RouteEntry[]>();
  for (const file of walk(API_SRC, (f) => f.endsWith('.controller.ts'))) {
    byFile.set(rel(file), extractRoutes(fs.readFileSync(file, 'utf8')));
  }
  return byFile;
}

function manualPages(): string[] {
  const pages = walk(path.join(ROOT, 'docs'), (f) => f.endsWith('.md')).map(rel);
  for (const extra of ['README.md']) if (fs.existsSync(path.join(ROOT, extra))) pages.push(extra);
  return pages.filter((p) => !IGNORED_DOCS.has(p));
}

/**
 * True when a declared route covers the documented one. Pages show concrete
 * examples (`GET /api/rest/v1/todos`), so a parameter segment in the
 * controller (`:table`, normalised to `:`) matches any value in that position.
 */
function isDeclared(key: string, declared: Set<string>): boolean {
  if (declared.has(key)) return true;
  const [method, docPath] = key.split(' ');
  const docSegments = docPath.split('/');
  for (const candidate of declared) {
    const [m, p] = candidate.split(' ');
    if (m !== method) continue;
    const segments = p.split('/');
    if (segments.length !== docSegments.length) continue;
    if (segments.every((s, i) => s === ':' || s === docSegments[i])) return true;
  }
  return false;
}

/** Documented routes that no controller declares, as `METHOD /path` strings. */
export function undeclaredRoutes(markdown: string, declared: Set<string>): string[] {
  return extractDocumentedRoutes(markdown)
    .filter((r) => !isDeclared(routeKey(r), declared))
    .map((r) => `${r.method} ${r.path}`);
}

describe('docs ↔ controllers', () => {
  const inventory = controllerInventory();
  const declared = new Set([...inventory.values()].flat().map(routeKey));
  const pages = manualPages();

  it('finds the controllers and the manual', () => {
    expect(inventory.size).toBeGreaterThan(20);
    expect(pages.length).toBeGreaterThan(10);
  });

  it('every route a page names exists in a controller', () => {
    const stale: string[] = [];
    for (const page of pages) {
      for (const route of undeclaredRoutes(fs.readFileSync(path.join(ROOT, page), 'utf8'), declared)) {
        stale.push(`${page}: ${route}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('every mapped page and controller exists', () => {
    const missing = DOC_MAP.flatMap((e) => [e.doc, ...e.controllers]).filter(
      (p) => !fs.existsSync(path.join(ROOT, p)),
    );
    expect(missing).toEqual([]);
  });

  it('mapped controller routes appear in the manual (strict with DOCS_STRICT=1)', () => {
    const documented = new Set(
      pages.flatMap((p) => extractDocumentedRoutes(fs.readFileSync(path.join(ROOT, p), 'utf8'))).map(routeKey),
    );
    const undocumented: string[] = [];
    for (const entry of DOC_MAP) {
      for (const controller of entry.controllers) {
        for (const route of inventory.get(controller) ?? []) {
          const key = routeKey(route);
          if (documented.has(key)) continue;
          if (entry.excluded?.some((re) => re.test(`${route.method} ${route.path}`))) continue;
          undocumented.push(`${entry.doc} lacks ${route.method} ${route.path} (${controller})`);
        }
      }
    }
    if (process.env.DOCS_STRICT === '1') {
      expect(undocumented).toEqual([]);
    } else if (undocumented.length) {
      console.warn(`Routes not in the manual yet (DOCS_STRICT=1 makes this fail):\n${undocumented.join('\n')}`);
    }
  });

  it('a page naming a route that does not exist is caught', () => {
    // `/api/rest/v1/<anything>` is a real route (any table name), so the
    // example has to be a path no controller can serve at all.
    expect(undeclaredRoutes('See `GET /api/no-such-module/endpoint`.', declared)).toEqual([
      'GET /api/no-such-module/endpoint',
    ]);
    expect(undeclaredRoutes('See `GET /api/rest/v1/todos`.', declared)).toEqual([]);
    expect(undeclaredRoutes('See `POST /api/sql/execute`.', declared)).toEqual([]);
  });
});
