/**
 * A small, dependency-free lexer for the SQL that reaches /sql/execute.
 *
 * It does not parse SQL. It answers the few questions the SQL route has to ask
 * of a statement before running it, and answers them on tokens rather than on
 * raw text, so that a word inside a string, a comment or an identifier is
 * never mistaken for syntax:
 *
 *  - where one statement ends and the next begins (semicolons inside strings,
 *    dollar-quoted bodies, comments and BEGIN ATOMIC function bodies do not
 *    count);
 *  - what kind of statement it is — a plain read, a WITH that modifies data,
 *    a data-modifying statement, or anything else — which decides whether it
 *    can be wrapped for pagination;
 *  - which keywords it contains, as whole words (`payload` is not `LOAD`).
 *
 * The rules follow the Postgres lexer: nested block comments, standard and
 * E'' strings, U&'' / U&"" Unicode escapes with UESCAPE, and $tag$ quoting.
 */

export type TokenType =
  | 'word' // unquoted identifier or keyword
  | 'qident' // "quoted identifier" (value = decoded name)
  | 'string' // any string literal (value = decoded content)
  | 'number'
  | 'param' // $1
  | 'op' // operator characters
  | 'punct'; // ( ) [ ] , ; . :

export interface Token {
  type: TokenType;
  /** Decoded value: the content of a string or quoted identifier, the text otherwise. */
  value: string;
  /** Upper-cased value for words; the value itself for everything else. */
  upper: string;
  /** Offsets of the token in the source text (end exclusive). */
  start: number;
  end: number;
  /** For strings: how it was quoted. */
  quote?: 'standard' | 'escape' | 'unicode' | 'dollar' | 'bit';
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';
const OP_CHARS = '+-*/<>=~!@#%^&|`?';

/** Decode the escapes of an E'' string body (already stripped of its quotes). */
function decodeEscapeString(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" && body[i + 1] === "'") {
      out += "'";
      i++;
      continue;
    }
    if (c !== '\\' || i === body.length - 1) {
      out += c;
      continue;
    }
    const n = body[++i];
    switch (n) {
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'x': {
        const m = /^[0-9A-Fa-f]{1,2}/.exec(body.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += 'x';
        break;
      }
      case 'u':
      case 'U': {
        const len = n === 'u' ? 4 : 8;
        const hex = body.slice(i + 1, i + 1 + len);
        if (new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) {
          out += safeFromCodePoint(parseInt(hex, 16));
          i += len;
        } else out += n;
        break;
      }
      default: {
        const m = /^[0-7]{1,3}/.exec(body.slice(i));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
          i += m[0].length - 1;
        } else out += n;
      }
    }
  }
  return out;
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** Decode a U&'' / U&"" body with the given escape character. */
function decodeUnicode(body: string, esc = '\\'): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== esc) {
      out += c;
      continue;
    }
    if (body[i + 1] === esc) {
      out += esc;
      i++;
      continue;
    }
    if (body[i + 1] === '+' && /^[0-9A-Fa-f]{6}$/.test(body.slice(i + 2, i + 8))) {
      out += safeFromCodePoint(parseInt(body.slice(i + 2, i + 8), 16));
      i += 7;
      continue;
    }
    if (/^[0-9A-Fa-f]{4}$/.test(body.slice(i + 1, i + 5))) {
      out += safeFromCodePoint(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Read a quoted run starting at `i` (which points at the opening quote).
 * Returns the raw body (doubled quotes kept) and the index after the closing
 * quote. `backslashEscapes` makes \' not terminate (E'' strings). An
 * unterminated literal runs to the end of the text, as Postgres would reject
 * it anyway.
 */
function readQuoted(
  sql: string,
  i: number,
  q: string,
  backslashEscapes = false,
): { body: string; next: number } {
  let j = i + 1;
  while (j < sql.length) {
    const c = sql[j];
    if (backslashEscapes && c === '\\') {
      j += 2;
      continue;
    }
    if (c === q) {
      if (sql[j + 1] === q) {
        j += 2;
        continue;
      }
      return { body: sql.slice(i + 1, j), next: j + 1 };
    }
    j++;
  }
  return { body: sql.slice(i + 1), next: sql.length };
}

/** Index after the comment that starts at `i`, or -1 when none starts there. */
function skipComment(sql: string, i: number): number {
  if (sql[i] === '-' && sql[i + 1] === '-') {
    const nl = sql.indexOf('\n', i);
    return nl === -1 ? sql.length : nl + 1;
  }
  if (sql[i] === '/' && sql[i + 1] === '*') {
    // Postgres block comments nest.
    let depth = 1;
    let j = i + 2;
    while (j < sql.length && depth > 0) {
      if (sql[j] === '/' && sql[j + 1] === '*') {
        depth++;
        j += 2;
      } else if (sql[j] === '*' && sql[j + 1] === '/') {
        depth--;
        j += 2;
      } else j++;
    }
    return j;
  }
  return -1;
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  const push = (t: Omit<Token, 'upper'> & { upper?: string }) =>
    tokens.push({ ...t, upper: t.upper ?? t.value });
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const afterComment = skipComment(sql, i);
    if (afterComment !== -1) {
      i = afterComment;
      continue;
    }

    // Prefixed literals: E'..', B'..', X'..', N'..', U&'..', U&".."
    if ((c === 'E' || c === 'e') && sql[i + 1] === "'") {
      const { body, next } = readQuoted(sql, i + 1, "'", true);
      push({ type: 'string', value: decodeEscapeString(body), start: i, end: next, quote: 'escape' });
      i = next;
      continue;
    }
    if ((c === 'B' || c === 'b' || c === 'X' || c === 'x') && sql[i + 1] === "'") {
      const { body, next } = readQuoted(sql, i + 1, "'");
      push({ type: 'string', value: body, start: i, end: next, quote: 'bit' });
      i = next;
      continue;
    }
    if ((c === 'N' || c === 'n') && sql[i + 1] === "'") {
      const { body, next } = readQuoted(sql, i + 1, "'");
      push({ type: 'string', value: body.replace(/''/g, "'"), start: i, end: next, quote: 'standard' });
      i = next;
      continue;
    }
    if ((c === 'U' || c === 'u') && sql[i + 1] === '&' && (sql[i + 2] === "'" || sql[i + 2] === '"')) {
      const q = sql[i + 2];
      const { body, next } = readQuoted(sql, i + 2, q);
      const raw = body.split(q + q).join(q);
      push({
        type: q === "'" ? 'string' : 'qident',
        value: raw, // decoded below, once a UESCAPE clause (if any) is known
        start: i,
        end: next,
        quote: 'unicode',
      });
      i = next;
      continue;
    }

    if (c === "'") {
      const { body, next } = readQuoted(sql, i, "'");
      push({ type: 'string', value: body.replace(/''/g, "'"), start: i, end: next, quote: 'standard' });
      i = next;
      continue;
    }
    if (c === '"') {
      const { body, next } = readQuoted(sql, i, '"');
      push({ type: 'qident', value: body.replace(/""/g, '"'), start: i, end: next });
      i = next;
      continue;
    }

    if (c === '$') {
      const dollar = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (dollar) {
        const delim = dollar[0];
        const bodyStart = i + delim.length;
        const close = sql.indexOf(delim, bodyStart);
        const end = close === -1 ? n : close + delim.length;
        push({
          type: 'string',
          value: sql.slice(bodyStart, close === -1 ? n : close),
          start: i,
          end,
          quote: 'dollar',
        });
        i = end;
        continue;
      }
      const param = /^\$\d+/.exec(sql.slice(i));
      if (param) {
        push({ type: 'param', value: param[0], start: i, end: i + param[0].length });
        i += param[0].length;
        continue;
      }
    }

    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(sql[j])) j++;
      const text = sql.slice(i, j);
      push({ type: 'word', value: text, upper: text.toUpperCase(), start: i, end: j });
      i = j;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) {
        // An exponent sign: 1e+5 / 1E-3
        if ((sql[j] === 'e' || sql[j] === 'E') && (sql[j + 1] === '+' || sql[j + 1] === '-')) j++;
        j++;
      }
      push({ type: 'number', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    if ('()[],;.:'.includes(c)) {
      push({ type: 'punct', value: c, start: i, end: i + 1 });
      i++;
      continue;
    }

    if (OP_CHARS.includes(c)) {
      let j = i + 1;
      // An operator never swallows the start of a comment.
      while (
        j < n &&
        OP_CHARS.includes(sql[j]) &&
        !(sql[j] === '-' && sql[j + 1] === '-') &&
        !(sql[j] === '/' && sql[j + 1] === '*')
      ) {
        j++;
      }
      push({ type: 'op', value: sql.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }

    // Anything else (stray characters) is kept as a one-character operator.
    push({ type: 'op', value: c, start: i, end: i + 1 });
    i++;
  }

  // U&'' / U&"" with an optional UESCAPE 'c' clause after them.
  const out: Token[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.quote === 'unicode') {
      let esc = '\\';
      const u = tokens[k + 1];
      const lit = tokens[k + 2];
      if (u?.type === 'word' && u.upper === 'UESCAPE' && lit?.type === 'string' && lit.value.length === 1) {
        esc = lit.value;
        k += 2;
      }
      const value = decodeUnicode(t.value, esc);
      out.push({ ...t, value, upper: value });
      continue;
    }
    out.push(t);
  }
  return out;
}

// ── Statements ──────────────────────────────────────────────────────────────

export interface Statement {
  tokens: Token[];
  /** Source text of the statement: first token to last, no trailing `;` or comment. */
  text: string;
  start: number;
  end: number;
}

/**
 * Split a script into statements on top-level semicolons. A semicolon inside
 * a `BEGIN ATOMIC … END` function body belongs to the body, as psql treats it.
 */
export function splitStatements(sql: string, tokens: Token[] = tokenize(sql)): Statement[] {
  const statements: Statement[] = [];
  let current: Token[] = [];
  let beginDepth = 0;

  const flush = () => {
    if (current.length) {
      const start = current[0].start;
      const end = current[current.length - 1].end;
      statements.push({ tokens: current, text: sql.slice(start, end), start, end });
    }
    current = [];
    beginDepth = 0;
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'punct' && t.value === ';' && beginDepth === 0) {
      flush();
      continue;
    }
    if (t.type === 'word' && current.length && current[0].type === 'word' && current[0].upper === 'CREATE') {
      // CREATE FUNCTION/PROCEDURE … BEGIN ATOMIC … END; inside it, CASE … END nests.
      if (t.upper === 'BEGIN' && isWord(tokens[k + 1], 'ATOMIC')) beginDepth++;
      else if (t.upper === 'CASE' && beginDepth > 0) beginDepth++;
      else if (t.upper === 'END' && beginDepth > 0) beginDepth--;
    }
    current.push(t);
  }
  flush();
  return statements;
}

// ── Classification ─────────────────────────────────────────────────────────

export type StatementKind =
  /** SELECT / VALUES / TABLE, or a WITH whose parts all read: safe to wrap as a subquery. */
  | 'select'
  /** A WITH that modifies data and ends in a SELECT: runs once, cannot be a subquery. */
  | 'select_with_dml'
  /** INSERT / UPDATE / DELETE / MERGE, with or without a WITH in front. */
  | 'dml'
  /** Everything else: DDL, utility statements, SELECT … INTO, EXPLAIN … */
  | 'other';

export interface StatementInfo {
  kind: StatementKind;
  /** The primary query has its own LIMIT / OFFSET / FETCH at the top level. */
  hasTopLevelLimit: boolean;
}

const DML_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
const SELECT_WORDS = new Set(['SELECT', 'VALUES', 'TABLE']);

const isPunct = (t: Token | undefined, v: string) => t?.type === 'punct' && t.value === v;
const isWord = (t: Token | undefined, v: string) => t?.type === 'word' && t.upper === v;

/** Index of the parenthesis that closes the one at `open`, or tokens.length. */
function closingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(tokens[k], '(') || isPunct(tokens[k], '[')) depth++;
    else if (isPunct(tokens[k], ')') || isPunct(tokens[k], ']')) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return tokens.length;
}

/** First word of a token run, looking past leading parentheses. */
function leadingWord(tokens: Token[]): Token | undefined {
  for (const t of tokens) {
    if (isPunct(t, '(')) continue;
    return t.type === 'word' ? t : undefined;
  }
  return undefined;
}

/** Words at paren depth 0 of `tokens[from..to)`. */
function topLevelWords(tokens: Token[], from: number, to: number): Token[] {
  const out: Token[] = [];
  let depth = 0;
  for (let k = from; k < to; k++) {
    const t = tokens[k];
    if (isPunct(t, '(') || isPunct(t, '[')) depth++;
    else if (isPunct(t, ')') || isPunct(t, ']')) depth--;
    else if (depth === 0 && t.type === 'word') out.push(t);
  }
  return out;
}

interface WithParts {
  /** Index of the first token of the primary statement. */
  primary: number;
  /** One token run per CTE body (without its parentheses). */
  bodies: Token[][];
}

/** Walk `WITH [RECURSIVE] name [(cols)] AS [NOT] [MATERIALIZED] ( … ) [, …]`. */
function parseWith(tokens: Token[]): WithParts | null {
  let k = 1; // tokens[0] is WITH
  if (isWord(tokens[k], 'RECURSIVE')) k++;
  const bodies: Token[][] = [];
  for (;;) {
    // CTE name
    if (!tokens[k] || (tokens[k].type !== 'word' && tokens[k].type !== 'qident')) return null;
    k++;
    if (isPunct(tokens[k], '(')) k = closingParen(tokens, k) + 1; // column list
    if (!isWord(tokens[k], 'AS')) return null;
    k++;
    if (isWord(tokens[k], 'NOT')) k++;
    if (isWord(tokens[k], 'MATERIALIZED')) k++;
    if (!isPunct(tokens[k], '(')) return null;
    const close = closingParen(tokens, k);
    bodies.push(tokens.slice(k + 1, close));
    k = close + 1;
    // SEARCH { BREADTH | DEPTH } FIRST BY cols SET col / CYCLE cols SET col [TO v DEFAULT v] USING col
    while (isWord(tokens[k], 'SEARCH') || isWord(tokens[k], 'CYCLE')) {
      const isCycle = isWord(tokens[k], 'CYCLE');
      while (k < tokens.length && !isWord(tokens[k], 'SET')) k++;
      k += 2; // SET col
      if (isCycle) {
        if (isWord(tokens[k], 'TO')) k += 4; // TO v DEFAULT v
        if (isWord(tokens[k], 'USING')) k += 2;
      }
    }
    if (isPunct(tokens[k], ',')) {
      k++;
      continue;
    }
    return { primary: k, bodies };
  }
}

/** Does this run of tokens (a statement or a CTE body) modify data anywhere at its top? */
function modifiesData(tokens: Token[]): boolean {
  const first = leadingWord(tokens);
  if (!first) return false;
  if (DML_WORDS.has(first.upper)) return true;
  if (first.upper === 'WITH') {
    const start = tokens.indexOf(first);
    const parts = parseWith(tokens.slice(start));
    if (!parts) return true; // unknown shape: assume the worst
    if (parts.bodies.some(modifiesData)) return true;
    return modifiesData(tokens.slice(start + parts.primary));
  }
  return false;
}

function hasLimitAtTop(tokens: Token[], from: number): boolean {
  return topLevelWords(tokens, from, tokens.length).some((w) =>
    w.upper === 'LIMIT' || w.upper === 'OFFSET' || w.upper === 'FETCH',
  );
}

function hasIntoAtTop(tokens: Token[], from: number): boolean {
  return topLevelWords(tokens, from, tokens.length).some((w) => w.upper === 'INTO');
}

export function classifyStatement(tokens: Token[]): StatementInfo {
  const first = tokens[0];
  if (!first) return { kind: 'other', hasTopLevelLimit: false };

  if (first.type === 'word' && first.upper === 'WITH') {
    const parts = parseWith(tokens);
    if (!parts) return { kind: 'other', hasTopLevelLimit: false };
    const primary = tokens.slice(parts.primary);
    const lead = leadingWord(primary);
    const cteWrites = parts.bodies.some(modifiesData);
    if (lead && DML_WORDS.has(lead.upper)) return { kind: 'dml', hasTopLevelLimit: false };
    const selectPrimary =
      (lead && SELECT_WORDS.has(lead.upper)) || isPunct(primary[0], '(');
    if (!selectPrimary || hasIntoAtTop(tokens, parts.primary)) {
      return { kind: 'other', hasTopLevelLimit: false };
    }
    return {
      kind: cteWrites ? 'select_with_dml' : 'select',
      hasTopLevelLimit: hasLimitAtTop(tokens, parts.primary),
    };
  }

  const lead = leadingWord(tokens);
  if (lead && DML_WORDS.has(lead.upper) && lead === first) {
    return { kind: 'dml', hasTopLevelLimit: false };
  }
  if (lead && (SELECT_WORDS.has(lead.upper) || (lead.upper === 'WITH' && isPunct(first, '(')))) {
    if (hasIntoAtTop(tokens, 0)) return { kind: 'other', hasTopLevelLimit: false };
    if (lead.upper === 'WITH' && modifiesData(tokens)) {
      // ( WITH … INSERT … ) — not something a subquery may contain.
      return { kind: 'other', hasTopLevelLimit: false };
    }
    return { kind: 'select', hasTopLevelLimit: hasLimitAtTop(tokens, 0) };
  }
  return { kind: 'other', hasTopLevelLimit: false };
}
