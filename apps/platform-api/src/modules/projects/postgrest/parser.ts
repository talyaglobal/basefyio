import {
  Condition,
  FieldRef,
  FilterNode,
  FilterOp,
  FILTER_OPS,
  JsonPathStep,
  LogicTree,
  OrderTerm,
  ParsedQuery,
  PostgrestParseError,
  SelectEmbed,
  SelectItem,
} from './types';

/**
 * Parse a PostgREST-compatible query string into a structured tree.
 *
 * supabase-js and postgrest-js encode a whole query — chosen columns, embedded
 * relations, boolean filter trees, ordering and paging — into the URL. Parsing
 * it here is what lets a project's client code run against basefyio without a
 * rewrite. The output is deliberately inert: names to be checked against the
 * schema, operators from a fixed set, and operands kept aside as bind values.
 */

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, what: string): string {
  if (!IDENT.test(name)) {
    throw new PostgrestParseError(`Invalid ${what}: "${name}"`);
  }
  return name;
}

/* ───────────────────────────── field references ───────────────────────────── */

/**
 * A column with an optional JSON path: `data`, `data->a`, `data->a->>b`.
 * The last `->>` yields text; `->` yields json. Only used where a column is
 * expected (select, filter, order).
 */
function parseFieldRef(raw: string): FieldRef {
  const parts = raw.split(/(->>|->)/);
  const column = assertIdent(parts[0], 'column');
  const jsonPath: JsonPathStep[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i] as '->' | '->>';
    let key = parts[i + 1] ?? '';
    // A JSON key may be quoted or an array index; keep it as a literal, never SQL.
    key = key.replace(/^["']|["']$/g, '');
    if (key === '') throw new PostgrestParseError(`Empty JSON key in "${raw}"`);
    jsonPath.push({ op, key });
  }
  return { column, jsonPath };
}

/* ───────────────────────────────── select ─────────────────────────────────── */

/**
 * Parse the `select` list, which can nest: `id,author:users!inner(name,posts(*))`.
 *
 * Hand-written rather than regex because embeds are parenthesised to arbitrary
 * depth. The scanner walks once, splitting on top-level commas and recursing
 * into each embed's own parentheses.
 */
export function parseSelect(input?: string): SelectItem[] {
  if (!input || input.trim() === '') return [{ kind: 'star' }];
  const items = splitTopLevel(input, ',').map((tok) => parseSelectItem(tok.trim()));
  if (items.length === 0) return [{ kind: 'star' }];
  return items;
}

function parseSelectItem(token: string): SelectItem {
  if (token === '*') return { kind: 'star' };

  // alias:target — the alias is always a plain identifier. A `::` is a cast,
  // not an alias separator, so only a single colon counts.
  let alias: string | undefined;
  const colonIdx = topLevelAliasColon(token);
  let rest = token;
  if (colonIdx !== -1) {
    alias = assertIdent(token.slice(0, colonIdx), 'alias');
    rest = token.slice(colonIdx + 1);
  }

  const parenIdx = rest.indexOf('(');
  if (parenIdx !== -1 && rest.endsWith(')')) {
    // Embedded resource: relation[!hint][!inner](sub-select)
    const head = rest.slice(0, parenIdx);
    const inner = rest.slice(parenIdx + 1, -1);
    const segments = head.split('!').map((s) => s.trim()).filter(Boolean);
    const relation = assertIdent(segments[0], 'embedded relation');
    let hint: string | undefined;
    let isInner = false;
    for (const seg of segments.slice(1)) {
      if (seg === 'inner') isInner = true;
      else hint = assertIdent(seg, 'embed hint');
    }
    const embed: SelectEmbed = {
      kind: 'embed',
      relation,
      alias,
      hint,
      inner: isInner,
      select: parseSelect(inner),
    };
    return embed;
  }

  // Plain column, optionally cast: `count::text`, `data->>x::int`.
  let cast: string | undefined;
  const castIdx = rest.indexOf('::');
  if (castIdx !== -1) {
    cast = assertIdent(rest.slice(castIdx + 2), 'cast type');
    rest = rest.slice(0, castIdx);
  }
  return { kind: 'column', field: parseFieldRef(rest), alias, cast };
}

/* ───────────────────────────────── filters ────────────────────────────────── */

/**
 * Parse one filter value, e.g. `eq.active`, `in.(1,2,3)`, `not.ilike.*foo*`,
 * `fts(english).cat`. `not.` negates whatever follows.
 */
export function parseConditionValue(column: string, value: string): Condition {
  let negate = false;
  let rest = value;
  if (rest.startsWith('not.')) {
    negate = true;
    rest = rest.slice(4);
  }

  const dot = rest.indexOf('.');
  if (dot === -1) {
    throw new PostgrestParseError(`Filter on "${column}" needs an operator: "${value}"`);
  }

  let opToken = rest.slice(0, dot);
  const operand = rest.slice(dot + 1);

  // Text-search operators carry a config: fts(english), plfts(simple)…
  let ftsConfig: string | undefined;
  const cfg = opToken.match(/^(fts|plfts|phfts|wfts)\(([A-Za-z_][A-Za-z0-9_]*)\)$/);
  if (cfg) {
    opToken = cfg[1];
    ftsConfig = cfg[2];
  }

  if (!FILTER_OPS.has(opToken)) {
    throw new PostgrestParseError(`Unknown operator "${opToken}" on "${column}"`);
  }

  return {
    kind: 'cond',
    field: parseFieldRef(column),
    op: opToken as FilterOp,
    negate,
    value: operand,
    ftsConfig,
  };
}

/**
 * Parse a logical group body: the inside of `or=(...)` / `and=(...)`.
 * Entries are either nested `and(...)`/`or(...)`/`not.and(...)` or
 * `column.op.operand` triples.
 */
export function parseLogicChildren(body: string): FilterNode[] {
  return splitTopLevel(body, ',').map((raw) => parseLogicNode(raw.trim()));
}

function parseLogicNode(token: string): FilterNode {
  let negate = false;
  let rest = token;
  if (rest.startsWith('not.')) {
    // not.and(...) / not.or(...) — negation of a group. A plain not.op on a
    // column is handled by parseConditionValue, so only group negation lands here.
    const after = rest.slice(4);
    if (/^(and|or)\s*\(/.test(after)) {
      negate = true;
      rest = after;
    }
  }

  const groupMatch = rest.match(/^(and|or)\((.*)\)$/s);
  if (groupMatch) {
    const node: LogicTree = {
      kind: 'logic',
      op: groupMatch[1] as 'and' | 'or',
      negate,
      children: parseLogicChildren(groupMatch[2]),
    };
    return node;
  }

  // column.op.operand — inside a logic group the operator and operand are
  // dot-joined to the column rather than passed as `column=op.operand`.
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) {
    throw new PostgrestParseError(`Malformed condition in logic group: "${token}"`);
  }
  const column = rest.slice(0, firstDot);
  const opAndVal = rest.slice(firstDot + 1);
  return parseConditionValue(column, opAndVal);
}

/* ─────────────────────────── order / top-level parse ───────────────────────── */

function parseOrder(value: string): OrderTerm[] {
  return value.split(',').map((part) => {
    const segs = part.trim().split('.');
    const field = parseFieldRef(segs[0]);
    let dir: 'asc' | 'desc' = 'asc';
    let nulls: 'first' | 'last' | undefined;
    for (const s of segs.slice(1)) {
      if (s === 'asc' || s === 'desc') dir = s;
      else if (s === 'nullsfirst') nulls = 'first';
      else if (s === 'nullslast') nulls = 'last';
      else throw new PostgrestParseError(`Unknown order modifier "${s}"`);
    }
    return { field, dir, nulls };
  });
}

/**
 * Split a query key into an embed path and a leaf name:
 * `comments.author.order` → path `comments.author`, leaf `order`.
 * The leaf is the last segment; everything before is the resource path.
 */
function splitEmbeddedKey(key: string): { path: string; leaf: string } {
  const idx = key.lastIndexOf('.');
  if (idx === -1) return { path: '', leaf: key };
  return { path: key.slice(0, idx), leaf: key.slice(idx + 1) };
}

/**
 * Turn the raw query-string map into a {@link ParsedQuery}. Values arrive as
 * strings (or string arrays when a key repeats — several filters on one column).
 */
export function parseQuery(
  query: Record<string, string | string[] | undefined>,
): ParsedQuery {
  const result: ParsedQuery = {
    select: parseSelect(query.select as string | undefined),
    filters: new Map(),
    order: new Map(),
    limit: new Map(),
    offset: new Map(),
  };

  const addFilter = (path: string, node: FilterNode) => {
    const list = result.filters.get(path) ?? [];
    list.push(node);
    result.filters.set(path, list);
  };

  for (const [rawKey, rawVal] of Object.entries(query)) {
    if (rawVal === undefined) continue;
    const values = Array.isArray(rawVal) ? rawVal : [rawVal];

    // `select` is already consumed; `columns` is an insert-only hint we ignore.
    if (rawKey === 'select' || rawKey === 'columns') continue;

    const { path, leaf } = splitEmbeddedKey(rawKey);

    if (leaf === 'or' || leaf === 'and') {
      for (const v of values) {
        const body = v.replace(/^\(/, '').replace(/\)$/, '');
        addFilter(path, { kind: 'logic', op: leaf, negate: false, children: parseLogicChildren(body) });
      }
      continue;
    }
    if (leaf === 'order') {
      for (const v of values) result.order.set(path, parseOrder(v));
      continue;
    }
    if (leaf === 'limit') {
      const n = parseInt(values[0], 10);
      if (!Number.isNaN(n) && n >= 0) result.limit.set(path, Math.min(n, 1000));
      continue;
    }
    if (leaf === 'offset') {
      const n = parseInt(values[0], 10);
      if (!Number.isNaN(n) && n >= 0) result.offset.set(path, n);
      continue;
    }

    // Anything else is a column filter: the key is the column (possibly with a
    // JSON path), addressed to the root or an embedded resource via its path.
    // `comments.status=eq.open` → path `comments`, column `status`.
    const dot = leaf.indexOf('.');
    // A JSON path uses `->`, not `.`, so a dot in the leaf would only appear for
    // an embedded column already split above; treat the whole leaf as the column.
    const column = dot === -1 ? leaf : leaf;
    for (const v of values) {
      addFilter(path, parseConditionValue(column, v));
    }
  }

  return result;
}

/* ──────────────────────────── scanning helpers ────────────────────────────── */

/** Split on `sep`, ignoring separators nested inside parentheses or quotes. */
function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out.filter((s) => s.length > 0);
}

/**
 * Index of the alias-separating colon: the first top-level `:` that is not part
 * of a `::` cast, or -1. The alias always precedes any parentheses, so the scan
 * stops at the first `(`.
 */
function topLevelAliasColon(input: string): number {
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') return -1;
    else if (c === ':' && input[i + 1] !== ':' && input[i - 1] !== ':') return i;
    else if (c === ':') i++; // skip the second colon of a `::`
  }
  return -1;
}
