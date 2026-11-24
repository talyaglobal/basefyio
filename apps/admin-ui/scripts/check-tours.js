/* eslint-disable no-console */
/**
 * Build guard for the guided tours (lib/tours). Fails the build when a tour points at an anchor
 * that no longer exists, when copy breaks the rules, or when routes overlap. See lib/tours/README.md.
 *
 * Route and definition files are TypeScript with type-only imports: they are transpiled with the
 * project's `typescript` package and evaluated in isolation (a runtime import throws).
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const TOURS = path.join(ROOT, 'lib', 'tours');
const AREAS = ['chrome', 'workspace', 'project-data', 'project-services'];
const SOURCE_DIRS = ['app', 'components'];
const FORBIDDEN_SOURCE_DIRS = ['app/console', 'components/console', 'app/dashboard/admin'];
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);

const TOUR_ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const ANCHOR_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const MIN_STEPS = 2;
const MAX_STEPS = 12;
const MAX_TITLE = 40;
const MAX_TEXT = 140;
const MAX_WORDS = 16;

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/** Transpiles a TS file and evaluates it with no runtime imports allowed. */
function load(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    fileName: file,
  }).outputText;
  const exports = {};
  const req = (name) => {
    throw new Error(`${rel(file)} imports "${name}" at runtime; only \`import type\` is allowed here`);
  };
  new Function('exports', 'require', 'module', out)(exports, req, { exports });
  return exports;
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, files);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * The string literals that can become the attribute's value: the expression itself, both
 * branches of a conditional, both sides of || and ??, the right side of &&. Literals inside a
 * condition (method === 'GET' ? ...) are not values. Returns null when the expression does not parse.
 */
function valueLiterals(expr) {
  const sf = ts.createSourceFile('anchor.ts', `(${expr});`, ts.ScriptTarget.ES2019, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) return null;
  const stmt = sf.statements[0];
  if (!stmt || !ts.isExpressionStatement(stmt)) return null;
  const out = [];
  const visit = (n) => {
    if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)) return visit(n.expression);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return void out.push(n.text);
    if (ts.isConditionalExpression(n)) {
      visit(n.whenTrue);
      visit(n.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        visit(n.left);
        visit(n.right);
      } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        visit(n.right);
      }
    }
    // identifiers, undefined, null, calls: no literal value
  };
  visit(stmt.expression);
  return out;
}

// ── 1. Anchors in the source ─────────────────────────────────────────────────
/** anchor -> [{ file, line }] */
const sourceAnchors = new Map();
function addSource(anchor, file, line) {
  if (!sourceAnchors.has(anchor)) sourceAnchors.set(anchor, []);
  sourceAnchors.get(anchor).push({ file, line });
}

for (const dir of SOURCE_DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    const content = fs.readFileSync(file, 'utf8');
    const r = rel(file);
    const found = [];

    const attr = /\bdata-tour=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
    let m;
    while ((m = attr.exec(content)) !== null) {
      const line = lineOf(content, m.index);
      if (m[1] !== undefined || m[2] !== undefined) {
        found.push({ anchor: m[1] ?? m[2], line });
        continue;
      }
      const expr = m[3];
      if (/^\s*[\w.?]*tourAnchor\s*$/.test(expr)) continue; // values come from tourAnchor fields
      if (expr.includes('${') || expr.includes('`')) {
        err(`${r}:${line} data-tour={${expr.trim()}} uses a template; write the anchor as a string literal or a tourAnchor field`);
        continue;
      }
      const literals = valueLiterals(expr);
      if (literals === null) {
        err(`${r}:${line} data-tour={${expr.trim()}} could not be parsed`);
        continue;
      }
      if (literals.length === 0) {
        err(`${r}:${line} data-tour={${expr.trim()}} has no string literal; use a literal, a condition with literals, or tourAnchor`);
        continue;
      }
      for (const a of literals) found.push({ anchor: a, line });
    }

    const field = /\btourAnchor\s*:\s*["']([^"']+)["']/g;
    let fields = 0;
    while ((m = field.exec(content)) !== null) {
      fields += 1;
      found.push({ anchor: m[1], line: lineOf(content, m.index) });
    }
    // tourAnchor values only reach the DOM through data-tour={item.tourAnchor}; without it they are dead.
    if (fields > 0 && !/\bdata-tour=\{\s*[\w.?]*tourAnchor\s*\}/.test(content)) {
      err(`${r}: has tourAnchor fields but never renders data-tour={...tourAnchor}`);
    }

    for (const { anchor, line } of found) {
      if (!ANCHOR_PATTERN.test(anchor)) err(`${r}:${line} anchor "${anchor}" is not well-formed (${ANCHOR_PATTERN})`);
      if (FORBIDDEN_SOURCE_DIRS.some((d) => r === d || r.startsWith(d + '/'))) {
        err(`${r}:${line} anchor "${anchor}" is in an area that never gets tours`);
      }
      addSource(anchor, r, line);
    }
  }
}

for (const [anchor, uses] of sourceAnchors) {
  const files = [...new Set(uses.map((u) => u.file))];
  if (files.length > 1) err(`anchor "${anchor}" appears in more than one file: ${files.join(', ')}`);
}

// ── 2. Routes and definitions ────────────────────────────────────────────────
let match;
try {
  match = load(path.join(TOURS, 'match.ts'));
} catch (e) {
  err(`lib/tours/match.ts: ${e.message}`);
}

const routes = [];
const defs = [];
for (const area of AREAS) {
  for (const [kind, list, key] of [
    ['routes', routes, 'ROUTES'],
    ['definitions', defs, 'DEFINITIONS'],
  ]) {
    const file = path.join(TOURS, kind, `${area}.ts`);
    if (!fs.existsSync(file)) {
      err(`missing lib/tours/${kind}/${area}.ts`);
      continue;
    }
    try {
      const mod = load(file);
      if (!Array.isArray(mod[key])) err(`lib/tours/${kind}/${area}.ts must export const ${key} (an array)`);
      else for (const item of mod[key]) list.push({ ...item, __area: area });
    } catch (e) {
      err(`lib/tours/${kind}/${area}.ts: ${e.message}`);
    }
  }
}
for (const kind of ['routes', 'definitions']) {
  const index = path.join(TOURS, kind, 'index.ts');
  const src = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '';
  for (const area of AREAS) {
    if (!src.includes(`'./${area}'`)) err(`lib/tours/${kind}/index.ts does not import './${area}'`);
  }
}

const routeIds = new Map();
for (const r of routes) {
  const where = `routes/${r.__area}.ts "${r.id}"`;
  if (typeof r.id !== 'string' || !TOUR_ID_PATTERN.test(r.id) || r.id.length > 64) err(`${where}: bad tour id`);
  if (routeIds.has(r.id)) err(`${where}: tour id also used in routes/${routeIds.get(r.id).__area}.ts`);
  routeIds.set(r.id, r);
  if (r.kind !== 'chrome' && r.kind !== 'page') err(`${where}: kind must be 'chrome' or 'page'`);
  if (!Array.isArray(r.routes) || r.routes.length === 0) err(`${where}: needs at least one route`);
  for (const p of [...(r.routes || []), ...(r.except || [])]) {
    if (typeof p !== 'string' || !p.startsWith('/')) err(`${where}: route "${p}" must start with /`);
    else if ((r.routes || []).includes(p) && (p.startsWith('/console') || p.startsWith('/dashboard/admin'))) {
      err(`${where}: route "${p}" is in an area that never gets tours`);
    }
    if (typeof p === 'string' && p.includes('**') && !p.endsWith('/**')) err(`${where}: "**" is only allowed at the end ("/**")`);
  }
  if (r.kind === 'page' && (r.routes || []).some((p) => p.endsWith('/**'))) err(`${where}: page tours use exact routes, not "/**"`);
}

const defIds = new Map();
const COMPARISON = /-style\b|alternative to|better than|\bunlike\b|\bclone\b|\bcompared to\b/i;
let stepCount = 0;
for (const d of defs) {
  const where = `definitions/${d.__area}.ts "${d.id}"`;
  if (defIds.has(d.id)) err(`${where}: tour id defined twice`);
  defIds.set(d.id, d);
  const route = routeIds.get(d.id);
  if (!route) err(`${where}: no route with this id`);
  else if (route.__area !== d.__area) err(`${where}: route is in area "${route.__area}"; keep both in one area`);
  if (!sourceAnchors.has(d.ready)) err(`${where}: ready anchor "${d.ready}" is not in app/ or components/`);
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    err(`${where}: has ${steps.length} steps; ${MIN_STEPS} to ${MAX_STEPS} are allowed`);
  }
  const seenAnchors = new Set();
  for (const [i, s] of steps.entries()) {
    stepCount += 1;
    const sw = `${where} step ${i + 1} (${s.anchor})`;
    if (!ANCHOR_PATTERN.test(s.anchor || '')) err(`${sw}: anchor is not well-formed`);
    if (seenAnchors.has(s.anchor)) err(`${sw}: anchor used twice in this tour`);
    seenAnchors.add(s.anchor);
    if (!sourceAnchors.has(s.anchor)) err(`${sw}: anchor is not in app/ or components/ (add data-tour="${s.anchor}")`);
    for (const [label, value, max] of [
      ['title', s.title, MAX_TITLE],
      ['text', s.text, MAX_TEXT],
    ]) {
      if (typeof value !== 'string' || !value.trim()) {
        err(`${sw}: ${label} is empty`);
        continue;
      }
      if (value.length > max) err(`${sw}: ${label} is ${value.length} characters (max ${max})`);
      if (/[<>&]/.test(value)) err(`${sw}: ${label} contains < > or & (copy is inserted as HTML)`);
      if (/\bBasefyio\b|BASEFYIO/.test(value)) err(`${sw}: ${label} must write the product name as "basefyio"`);
      if (COMPARISON.test(value)) err(`${sw}: ${label} compares the product with another one`);
    }
    if (typeof s.text === 'string') {
      const words = s.text.trim().split(/\s+/).length;
      if (words > MAX_WORDS) err(`${sw}: text has ${words} words (max ${MAX_WORDS})`);
      if (!/[^.!?][.!?]$/.test(s.text.trim())) err(`${sw}: text must end with one . ! or ?`);
      if (/[.!?]\s/.test(s.text.trim())) err(`${sw}: text must be one sentence`);
    }
  }
}
for (const id of routeIds.keys()) if (!defIds.has(id)) err(`routes: "${id}" has no definition`);

// ── 3. Overlapping page routes ───────────────────────────────────────────────
if (match && typeof match.topPageMatches === 'function') {
  const plain = routes.map(({ __area, ...r }) => r);
  for (const r of plain) {
    for (const p of r.routes || []) {
      const sample = p.replace(/\/\*\*$/, '').replace(/\[[^\]]+\]/g, 'sample1') || '/';
      if (r.kind === 'page') {
        const top = match.topPageMatches(plain, sample);
        if (top.length > 1) err(`page tours ${top.map((t) => `"${t.id}"`).join(' and ')} both match ${sample}`);
        else if (!top.length || top[0].id !== r.id) err(`page tour "${r.id}": its own route ${p} picks "${top[0] ? top[0].id : 'nothing'}"`);
      } else {
        const got = match.matchTours(plain, sample, {}).chrome;
        if (!got) warn(`chrome tour "${r.id}": sample path ${sample} matches no chrome tour`);
      }
    }
  }
}

// ── 3b. Pages that never get a tour (plan: console, admin, orphan, changelog, redirect-only) ──
if (match && typeof match.matchTours === 'function') {
  const plain = routes.map(({ __area, ...r }) => r);
  const NO_TOUR_PATHS = [
    '/console',
    '/console/manage',
    '/dashboard/admin',
    '/dashboard/admin/sample1',
    '/dashboard/profile',
    '/dashboard/changelog',
    '/dashboard/changelog/sample1',
    '/dashboard/projects/sample1/data',
    '/dashboard/projects/sample1/collections',
  ];
  const allOn = { organizations_ui: true, nav_v2: true, guided_tours: true };
  const reported = new Set();
  for (const features of [{}, allOn]) {
    for (const p of NO_TOUR_PATHS) {
      const got = match.matchTours(plain, p, features);
      for (const t of [got.chrome, got.page]) {
        const msg = t && `tour "${t.id}" matches ${p}, a page that never gets tours (add it to "except")`;
        if (msg && !reported.has(msg)) {
          reported.add(msg);
          err(msg);
        }
      }
    }
  }
}

// ── 4. Unused anchors (warning only) ─────────────────────────────────────────
const used = new Set();
for (const d of defs) {
  used.add(d.ready);
  for (const s of d.steps || []) used.add(s.anchor);
}
const unused = [...sourceAnchors.keys()].filter((a) => !used.has(a));
if (unused.length) warn(`${unused.length} anchors in the source are not used by any tour yet: ${unused.join(', ')}`);

for (const w of warnings) console.warn(`[check-tours] warning: ${w}`);
if (errors.length) {
  console.error('\n[check-tours] Guided tour check failed. Build aborted.\n');
  for (const e of errors) console.error(`- ${e}`);
  console.error('\nSee lib/tours/README.md.\n');
  process.exit(1);
}
console.log(`[check-tours] Passed. ${defs.length} tours, ${stepCount} steps, ${sourceAnchors.size} anchors.`);
