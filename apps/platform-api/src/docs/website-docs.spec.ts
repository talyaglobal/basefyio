/**
 * The public website's docs (apps/website) against the controllers and the repository.
 *
 * route-coverage.spec.ts keeps the Markdown manual under docs/ honest; the
 * website pages are JSX and were never checked, so they drifted: /docs/auth
 * listed every route without the `/api` prefix, /docs/data-engine gave a base
 * path that answers 404, and /docs/self-hosting linked to repository files that
 * do not exist. This spec fails on each of those:
 *
 * (a) every route a website page names (`POST /api/...`, or a Method | Path
 *     table row) exists in a controller;
 * (b) no API path is written without the `/api` prefix;
 * (c) every link into github.com/talyaglobal/basefyio points at a file on main
 *     (and a README heading when it carries an anchor), and no page or package
 *     manifest names a retired repository;
 * (d) every docs nav entry and every in-site `/docs/...#anchor` link resolves.
 */
import * as fs from 'fs';
import * as path from 'path';
import { HTTP_METHODS, HttpMethod, extractRoutes, routeKey } from './route-inventory';

const ROOT = path.resolve(__dirname, '../../../..');
const API_SRC = path.join(ROOT, 'apps/platform-api/src');
const SITE_SRC = path.join(ROOT, 'apps/website/src');
const REPO_URL = 'https://github.com/talyaglobal/basefyio';
/** Package manifests whose repository metadata this suite guards (the SDK has its own owner). */
const MANIFESTS = ['packages/cli/package.json', 'packages/geo/package.json'];

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

/** JSX writes `{` as `&#123;`; decode the few entities a path can contain. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#123;/g, '{')
    .replace(/&#125;/g, '}')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Website source files that can carry API paths or links: pages, components, content, lib. */
function sitePages(): string[] {
  return walk(SITE_SRC, (f) => /\.(tsx?|mdx?)$/.test(f));
}

/** Same rule as route-coverage.spec.ts: a controller parameter matches any concrete value. */
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

const METHOD_ALT = HTTP_METHODS.join('|');

/** `METHOD /api/...` written inline or in a code block, and `<td>METHOD</td><td><code>/path</code>` rows. */
export function websiteRoutes(source: string): Array<{ method: HttpMethod; path: string }> {
  const text = decodeEntities(source);
  const found: Array<{ method: HttpMethod; path: string }> = [];
  const inline = new RegExp(`\\b(${METHOD_ALT})\\s+(/api/[^\\s\`'"<>\\\\]*)`, 'g');
  for (let m = inline.exec(text); m; m = inline.exec(text)) {
    found.push({ method: m[1] as HttpMethod, path: m[2] });
  }
  const row = new RegExp(`<td>\\s*(?:<code>)?\\s*(${METHOD_ALT})\\s*(?:</code>)?\\s*</td>\\s*<td>\\s*<code>\\s*(/[^<\\s]*)`, 'g');
  for (let m = row.exec(text); m; m = row.exec(text)) {
    found.push({ method: m[1] as HttpMethod, path: m[2] });
  }
  return found;
}

/** API paths written without the `/api` prefix the server mounts every route under. */
export function unprefixedPaths(source: string): string[] {
  const text = decodeEntities(source);
  const bad: string[] = [];
  for (const marker of ['/rest/v1/', '/v1/projects/', '/realtime/v1/']) {
    for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + 1)) {
      if (text.slice(Math.max(0, i - 4), i) !== '/api') bad.push(text.slice(i, i + 40).split(/[\s`'"<]/)[0]);
    }
  }
  // A path right after the API origin must start with /api.
  const origin = /(https?:\/\/api\.basefyio\.com|\$\{apiUrl\}|\{apiUrl\}|\$\{apiRoot\}|\{apiRoot\})(\/[A-Za-z_][^\s`'"<}]*)/g;
  for (let m = origin.exec(text); m; m = origin.exec(text)) {
    if (!/^\/api(\/|$)/.test(m[2])) bad.push(`${m[1]}${m[2]}`);
  }
  // A Method | Path table row whose path is not a full /api path.
  const row = new RegExp(`<td>\\s*(?:<code>)?\\s*(?:${METHOD_ALT})\\s*(?:</code>)?\\s*</td>\\s*<td>\\s*<code>\\s*(/[^<\\s]*)`, 'g');
  for (let m = row.exec(text); m; m = row.exec(text)) {
    if (!m[1].startsWith('/api/') && !m[1].startsWith('/_codefyio/')) bad.push(m[1]);
  }
  return bad;
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-');
}

/**
 * Links into the public repository, with `${CONST}` templates resolved from
 * the string constants the same file declares (the self-hosting page builds its
 * links that way).
 */
export function repositoryLinks(source: string): string[] {
  const consts = new Map<string, string>();
  const plain = /const (\w+)\s*=\s*"([^"]+)"/g;
  for (let m = plain.exec(source); m; m = plain.exec(source)) consts.set(m[1], m[2]);
  const templ = /const (\w+)\s*=\s*`([^`]*)`/g;
  for (let m = templ.exec(source); m; m = templ.exec(source)) {
    consts.set(m[1], m[2].replace(/\$\{(\w+)\}/g, (_, k) => consts.get(k) ?? `\${${k}}`));
  }
  const resolved = source.replace(/\$\{(\w+)\}/g, (whole, k) => consts.get(k) ?? whole);
  const links = resolved.match(/https:\/\/github\.com\/talyaglobal\/basefyio[^\s"'`)<>\]]*/g) ?? [];
  return [...new Set(links)];
}

/** Why a repository link does not resolve, or null when it does. */
function brokenRepositoryLink(link: string): string | null {
  const [base, anchor] = link.split('#');
  const tail = base.slice(REPO_URL.length).replace(/\.git$/, '');
  if (tail === '' || tail === '/' || /^\/(issues|pulls|releases|stargazers)(\/|$)/.test(tail)) {
    if (anchor && (tail === '' || tail === '/')) {
      const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      const slugs = (readme.match(/^#{1,6} .+$/gm) ?? []).map((h) => githubSlug(h.replace(/^#+ /, '')));
      return slugs.includes(anchor) ? null : `README has no heading for #${anchor}`;
    }
    return null;
  }
  const file = tail.match(/^\/(?:blob|tree)\/main\/(.+)$/);
  if (!file) return 'not a blob/tree link on main';
  return fs.existsSync(path.join(ROOT, decodeURIComponent(file[1]))) ? null : `${file[1]} does not exist`;
}

describe('website docs ↔ controllers and repository', () => {
  const declared = new Set(
    walk(API_SRC, (f) => f.endsWith('.controller.ts'))
      .flatMap((f) => extractRoutes(fs.readFileSync(f, 'utf8')))
      .map(routeKey),
  );
  const pages = sitePages();
  const docsPages = pages.filter((p) => rel(p).startsWith('apps/website/src/app/docs/'));

  it('finds the website docs and the controllers', () => {
    expect(declared.size).toBeGreaterThan(100);
    expect(docsPages.length).toBeGreaterThan(10);
  });

  it('every route a website page names exists in a controller', () => {
    const stale: string[] = [];
    for (const page of pages) {
      for (const route of websiteRoutes(fs.readFileSync(page, 'utf8'))) {
        if (!isDeclared(routeKey(route), declared)) stale.push(`${rel(page)}: ${route.method} ${route.path}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('no website page writes an API path without the /api prefix', () => {
    const bad = pages.flatMap((page) =>
      unprefixedPaths(fs.readFileSync(page, 'utf8')).map((p) => `${rel(page)}: ${p}`),
    );
    expect(bad).toEqual([]);
  });

  it('every link into the public repository resolves on main', () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const link of repositoryLinks(fs.readFileSync(page, 'utf8'))) {
        const why = brokenRepositoryLink(link);
        if (why) broken.push(`${rel(page)}: ${link} — ${why}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('no page or package manifest names a retired repository', () => {
    const retired = /github\.com\/(fsipka\/|talyaglobal\/(?!basefyio\b))[^\s"'`)<]*/g;
    const files = [...pages, ...MANIFESTS.map((m) => path.join(ROOT, m))];
    const hits = files.flatMap((f) =>
      (fs.readFileSync(f, 'utf8').match(retired) ?? []).map((hit) => `${rel(f)}: ${hit}`),
    );
    expect(hits).toEqual([]);
  });

  it('every docs nav entry has a page', () => {
    const nav = fs.readFileSync(path.join(SITE_SRC, 'app/docs/docs-nav-items.ts'), 'utf8');
    const hrefs = [...nav.matchAll(/href: "(\/docs[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(10);
    const missing = hrefs.filter((h) => !fs.existsSync(path.join(SITE_SRC, 'app', h, 'page.tsx')));
    expect(missing).toEqual([]);
  });

  it('every in-site /docs link points at a page, and at an id on it when it has an anchor', () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const m of fs.readFileSync(page, 'utf8').matchAll(/href="(\/docs[^"#?]*)(?:#([^"]+))?"/g)) {
        const target = path.join(SITE_SRC, 'app', m[1], 'page.tsx');
        if (!fs.existsSync(target)) {
          broken.push(`${rel(page)}: ${m[0]} — no page`);
        } else if (m[2] && !fs.readFileSync(target, 'utf8').includes(`id="${m[2]}"`)) {
          broken.push(`${rel(page)}: ${m[0]} — no id="${m[2]}"`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  describe('the checks themselves', () => {
    it('catch an unprefixed path, a 404 base path and a bad table row', () => {
      expect(unprefixedPaths('<code>POST /rest/v1/auth/signin</code>')).toEqual(['/rest/v1/auth/signin']);
      expect(unprefixedPaths('Base path: <code>{apiUrl}/v1/projects/:projectId</code>')).toEqual([
        '/v1/projects/:projectId',
        '{apiUrl}/v1/projects/:projectId',
      ]);
      expect(unprefixedPaths('<tr><td>GET</td><td><code>/projects/:id/tables</code></td>')).toEqual([
        '/projects/:id/tables',
      ]);
      expect(unprefixedPaths('curl "${apiUrl}/api/rest/v1/todos" and POST /api/rest/v1/auth/signin')).toEqual([]);
    });

    it('find routes inline and in table rows, and flag one no controller serves', () => {
      const routes = websiteRoutes(
        '<pre><code>{`GET /api/rest/v1/:table?select=*`}</code></pre><tr><td><code>DELETE</code></td><td><code>/api/no-such/route</code></td>',
      );
      expect(routes).toEqual([
        { method: 'GET', path: '/api/rest/v1/:table?select=*' },
        { method: 'DELETE', path: '/api/no-such/route' },
      ]);
      expect(isDeclared(routeKey(routes[0]), declared)).toBe(true);
      expect(isDeclared(routeKey(routes[1]), declared)).toBe(false);
    });

    it('resolve template links and reject a file that is not in the tree', () => {
      const src = 'const REPO = "https://github.com/talyaglobal/basefyio";\nconst REPO_DOCS = `${REPO}/blob/main/docs`;\n<a href={`${REPO_DOCS}/guides/self-hosting.md`}>';
      const links = repositoryLinks(src);
      expect(links).toContain('https://github.com/talyaglobal/basefyio/blob/main/docs/guides/self-hosting.md');
      expect(brokenRepositoryLink('https://github.com/talyaglobal/basefyio/blob/main/docs/guides/self-hosting.md')).toMatch(
        /does not exist/,
      );
      expect(brokenRepositoryLink('https://github.com/talyaglobal/basefyio/blob/main/docs/SELF_HOSTING_OFFLINE.md')).toBeNull();
      expect(brokenRepositoryLink('https://github.com/talyaglobal/basefyio#no-such-heading')).toMatch(/no heading/);
    });
  });
});
