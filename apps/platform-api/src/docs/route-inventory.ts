/**
 * Route inventory for the reference manual under docs/.
 *
 * Reads controller source as text (no Nest bootstrap, no imports of the
 * controllers themselves) and lists every HTTP route it declares, joined the
 * way Nest joins them at runtime: global prefix `api` + `@Controller(prefix)`
 * + the method decorator's sub-path. The Codefyio adapter is the one controller
 * served outside the prefix (see `setGlobalPrefix(... exclude ...)` in main.ts).
 *
 * The docs conformance spec uses this to fail when a documented route no longer
 * exists, and to list controller routes the manual does not mention yet.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RouteEntry {
  method: HttpMethod;
  /** Full path as served, e.g. `/api/projects/:projectId/storage/buckets`. */
  path: string;
}

/** Controllers whose prefix starts with one of these are not under `/api`. */
const PREFIX_EXCLUDED = ['_codefyio'];

const DECORATOR_TO_METHOD: Record<string, HttpMethod> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ALL',
};

/** Removes block comments and whole-line `//` comments, keeping line count. */
export function stripComments(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks.replace(/^[ \t]*\/\/.*$/gm, '');
}

/** First string literal argument of a decorator call, or '' for `()` / no path. */
function literalArg(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return '';
  const direct = trimmed.match(/^(['"`])([^'"`]*)\1/);
  if (direct) return direct[2];
  // @Controller({ path: 'x', ... })
  const objectPath = trimmed.match(/path\s*:\s*(['"`])([^'"`]*)\1/);
  if (objectPath) return objectPath[2];
  return '';
}

export function joinRoute(prefix: string, sub: string): string {
  const parts = [prefix, sub]
    .flatMap((p) => p.split('/'))
    .map((p) => p.trim())
    .filter(Boolean);
  const excluded = parts.length > 0 && PREFIX_EXCLUDED.includes(parts[0]);
  const all = excluded ? parts : ['api', ...parts];
  return '/' + all.join('/');
}

/**
 * Lists the routes declared in one source file. A file may hold several
 * controllers; each `@Controller(...)` opens a new one.
 */
export function extractRoutes(source: string): RouteEntry[] {
  const text = stripComments(source);
  const controllerRe = /@Controller\(([^)]*)\)/g;
  const starts: Array<{ index: number; prefix: string }> = [];
  for (let m = controllerRe.exec(text); m; m = controllerRe.exec(text)) {
    starts.push({ index: m.index, prefix: literalArg(m[1]) });
  }
  const routes: RouteEntry[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const body = text.slice(start.index, end);
    // A formatter may split the decorator across lines and leave a trailing comma.
    const methodRe = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\(\s*((?:'[^']*'|"[^"]*"|`[^`]*`)?)\s*,?\s*\)/g;
    for (let m = methodRe.exec(body); m; m = methodRe.exec(body)) {
      const sub = m[2] ? m[2].slice(1, -1) : '';
      routes.push({ method: DECORATOR_TO_METHOD[m[1]], path: joinRoute(start.prefix, sub) });
    }
  });
  return routes;
}

/**
 * Canonical form for comparison: query string and trailing slash removed,
 * every parameter segment (`:id`, `:projectId`, `<PROJECT_ID>`, `{id}`)
 * reduced to `:` so a page may name a parameter differently from the code.
 */
export function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0];
  const segments = withoutQuery
    .split('/')
    .filter(Boolean)
    .map((s) => (/^(:[A-Za-z0-9_]+\??|<[^>]+>|\{[^}]+\}|\$\{[^}]+\})$/.test(s) ? ':' : s));
  return '/' + segments.join('/');
}

export function routeKey(route: RouteEntry): string {
  return `${route.method} ${normalizePath(route.path)}`;
}

/**
 * Routes a Markdown page names, in any of the three forms the manual uses:
 *   inline code        `POST /api/sql/execute`
 *   a table row        | GET | `/api/projects/:projectId/storage/buckets` | ...
 *   a request line     GET /api/realtime/v1/stream        (alone on a line, in a code block)
 * A table method cell may list several methods: `GET / HEAD`, `PUT, DELETE`.
 */
export function extractDocumentedRoutes(markdown: string): RouteEntry[] {
  const found: RouteEntry[] = [];
  const methodAlt = HTTP_METHODS.join('|');
  const inline = new RegExp('`(' + methodAlt + ')\\s+(/[^`\\s]*)[^`]*`', 'g');
  for (let m = inline.exec(markdown); m; m = inline.exec(markdown)) {
    found.push({ method: m[1] as HttpMethod, path: m[2] });
  }
  const requestLine = new RegExp('^[ \\t]*(' + methodAlt + ')[ \\t]+(/\\S*)[ \\t]*(?:HTTP/[\\d.]+[ \\t]*)?$', 'gm');
  for (let m = requestLine.exec(markdown); m; m = requestLine.exec(markdown)) {
    found.push({ method: m[1] as HttpMethod, path: m[2] });
  }
  const row = new RegExp(
    '^\\|\\s*((?:' + methodAlt + ')(?:\\s*[/,]\\s*(?:' + methodAlt + '))*)\\s*\\|\\s*`(/[^`\\s]*)[^`]*`',
    'gm',
  );
  for (let m = row.exec(markdown); m; m = row.exec(markdown)) {
    for (const method of m[1].split(/\s*[/,]\s*/)) {
      found.push({ method: method as HttpMethod, path: m[2] });
    }
  }
  return found.filter((r) => r.path.startsWith('/api/') || r.path.startsWith('/_codefyio/'));
}
