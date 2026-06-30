/**
 * JS query parser — SQL-editor-style query text that looks like the basefyio
 * SDK (`collection("orders").find({...}).sort({...}).limit(10)`) parsed into
 * a validated EntityQuery.
 *
 * This is a hand-written tokenizer + recursive-descent parser over a CLOSED
 * grammar. It parses; it NEVER evaluates. There is no `eval`, no `Function`,
 * no parser library — anything outside the grammar (arrow functions, template
 * literals, operators, identifiers as values) is rejected with a
 * JsQueryParseError carrying a 1-based line/column.
 *
 * Filter, sort and path validation are delegated to the shared compiler in
 * ./filter-object.ts so both query frontends enforce identical rules.
 */

import { QueryValidationError } from '../interfaces/data-engine';
import type { EntityQuery, Filter, PathRef, SortClause } from '../interfaces/query';
import {
  assertSafePath,
  compileFilterObject,
  compileSortObject,
} from './filter-object';

// ── Public types ───────────────────────────────────────────

export interface ParsedJsQuery {
  entity: string;
  action: 'find' | 'count';
  query: EntityQuery;
}

/**
 * Parse/validation error with a 1-based source position. Extends
 * QueryValidationError so the API layer maps it to HTTP 400 uniformly.
 * The message already includes "(line N, col M)".
 */
export class JsQueryParseError extends QueryValidationError {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, col ${column})`);
    this.name = 'JsQueryParseError';
    this.line = line;
    this.column = column;
  }
}

// ── Limits ─────────────────────────────────────────────────

const MAX_SOURCE_LENGTH = 100_000;
const MAX_LITERAL_DEPTH = 32;
const MAX_ENTITY_NAME_LENGTH = 128;
const MAX_TOTAL_SORT_FIELDS = 5;

const ENTITY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keys that could poison prototypes. Rejected at parse time with position. */
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const SUPPORTED_METHODS = 'find, where, sort, limit, skip, offset, select, count';

// ── Tokens ─────────────────────────────────────────────────

type TokenType = 'string' | 'number' | 'identifier' | 'punct' | 'eof';

interface Token {
  type: TokenType;
  value: string | number;
  line: number;
  column: number;
}

const PUNCTUATION = new Set(['.', '(', ')', '{', '}', '[', ']', ':', ',', ';']);

const STRING_ESCAPES: Record<string, string> = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  n: '\n',
  t: '\t',
};

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string | undefined): boolean {
  return (
    ch !== undefined &&
    ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$')
  );
}

function isIdentPart(ch: string | undefined): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

/** Human-readable token label for error messages. */
function label(t: Token): string {
  switch (t.type) {
    case 'eof':
      return 'end of input';
    case 'string': {
      const s = String(t.value);
      return `string "${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`;
    }
    case 'number':
      return `number ${t.value}`;
    default:
      return `"${t.value}"`;
  }
}

// ── Lexer ──────────────────────────────────────────────────

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 1;

  const failAt = (message: string, l: number, c: number): never => {
    throw new JsQueryParseError(message, l, c);
  };

  while (i < n) {
    const ch = source[i];

    // Whitespace
    if (ch === '\n') {
      i++;
      line++;
      col = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      col++;
      continue;
    }

    // Comments
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        i++;
        col++;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      i += 2;
      col += 2;
      let closed = false;
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          col += 2;
          closed = true;
          break;
        }
        if (source[i] === '\n') {
          i++;
          line++;
          col = 1;
        } else {
          i++;
          col++;
        }
      }
      if (!closed) failAt('unterminated block comment', startLine, startCol);
      continue;
    }

    // Strings (single or double quotes)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      let value = '';
      for (;;) {
        if (i >= n) {
          failAt('unterminated string literal', startLine, startCol);
        }
        const c = source[i];
        if (c === '\n' || c === '\r') {
          failAt(
            'unterminated string literal — strings cannot span lines',
            startLine,
            startCol,
          );
        }
        if (c === '\\') {
          const esc = source[i + 1];
          if (esc === undefined) {
            failAt('unterminated string literal', startLine, startCol);
          }
          const mapped = STRING_ESCAPES[esc as string];
          if (mapped === undefined) {
            failAt(
              `unsupported escape sequence "\\${esc}" in string — supported: \\\\ \\' \\" \\n \\t`,
              line,
              col,
            );
          }
          value += mapped;
          i += 2;
          col += 2;
          continue;
        }
        if (c === quote) {
          i++;
          col++;
          break;
        }
        value += c;
        i++;
        col++;
      }
      tokens.push({ type: 'string', value, line: startLine, column: startCol });
      continue;
    }

    // Numbers: optional leading -, integer or decimal, optional exponent.
    if (isDigit(ch) || (ch === '-' && isDigit(source[i + 1]))) {
      const startLine = line;
      const startCol = col;
      const start = i;
      if (source[i] === '-') {
        i++;
        col++;
      }
      while (isDigit(source[i])) {
        i++;
        col++;
      }
      if (source[i] === '.') {
        if (!isDigit(source[i + 1])) {
          failAt('invalid number — expected digits after the decimal point', line, col);
        }
        i++;
        col++;
        while (isDigit(source[i])) {
          i++;
          col++;
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        i++;
        col++;
        if (source[i] === '+' || source[i] === '-') {
          i++;
          col++;
        }
        if (!isDigit(source[i])) {
          failAt('invalid number — expected digits in the exponent', line, col);
        }
        while (isDigit(source[i])) {
          i++;
          col++;
        }
      }
      if (isIdentStart(source[i])) {
        failAt(
          `invalid number — unexpected character "${source[i]}" after a number`,
          line,
          col,
        );
      }
      const raw = source.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        failAt(`number "${raw}" is too large`, startLine, startCol);
      }
      tokens.push({ type: 'number', value, line: startLine, column: startCol });
      continue;
    }

    // Identifiers / keywords (true, false, null are resolved by the parser)
    if (isIdentStart(ch)) {
      const startCol = col;
      const start = i;
      while (isIdentPart(source[i])) {
        i++;
        col++;
      }
      tokens.push({
        type: 'identifier',
        value: source.slice(start, i),
        line,
        column: startCol,
      });
      continue;
    }

    // Punctuation
    if (ch !== undefined && PUNCTUATION.has(ch)) {
      tokens.push({ type: 'punct', value: ch, line, column: col });
      i++;
      col++;
      continue;
    }

    // Everything else is outside the grammar.
    if (ch === '`') {
      failAt(
        'template literals are not supported — use single or double quotes for strings',
        line,
        col,
      );
    }
    if (ch === '=' && source[i + 1] === '>') {
      failAt(
        'arrow functions are not supported in queries — pass a filter object like { field: { $gt: 5 } } instead',
        line,
        col,
      );
    }
    failAt(
      `unexpected character "${ch}" — arrow functions and expressions are not supported in queries`,
      line,
      col,
    );
  }

  tokens.push({ type: 'eof', value: '', line, column: col });
  return tokens;
}

// ── Parser ─────────────────────────────────────────────────

class Parser {
  private pos = 0;

  // Chain state
  private hasFind = false;
  private filter: Filter | undefined;
  private sort: SortClause[] = [];
  private limit: number | undefined;
  private offset: number | undefined;
  private select: PathRef[] | undefined;
  private action: 'find' | 'count' = 'find';

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  private fail(message: string, token: Token): never {
    throw new JsQueryParseError(message, token.line, token.column);
  }

  private isPunct(t: Token, value: string): boolean {
    return t.type === 'punct' && t.value === value;
  }

  private expectPunct(value: string, context: string): Token {
    const t = this.next();
    if (!this.isPunct(t, value)) {
      this.fail(`expected "${value}" ${context} but found ${label(t)}`, t);
    }
    return t;
  }

  /**
   * Run a shared-compiler call (compileFilterObject / compileSortObject /
   * assertSafePath) and re-throw any QueryValidationError as a
   * JsQueryParseError anchored at the given token.
   */
  private delegate<T>(fn: () => T, token: Token): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof JsQueryParseError) throw e;
      if (e instanceof QueryValidationError) this.fail(e.message, token);
      throw e;
    }
  }

  parse(): ParsedJsQuery {
    const entity = this.parseRoot();

    while (this.isPunct(this.peek(), '.')) {
      this.next(); // consume '.'
      this.parseMethod();
    }

    if (this.isPunct(this.peek(), ';')) this.next();

    const tail = this.peek();
    if (tail.type !== 'eof') {
      this.fail(`unexpected ${label(tail)} after the query — expected end of input`, tail);
    }

    return this.buildResult(entity);
  }

  // root := 'collection' '(' string ')' | 'db' '.' identifier
  private parseRoot(): string {
    const first = this.peek();
    if (first.type === 'eof') {
      this.fail('query is empty — start with collection("entity") or db.entity', first);
    }

    let entity: string;
    let entityToken: Token;

    if (first.type === 'identifier' && first.value === 'collection') {
      this.next();
      this.expectPunct('(', 'after "collection"');
      const nameToken = this.next();
      if (nameToken.type !== 'string') {
        this.fail(
          'collection() requires a string literal entity name, e.g. collection("orders")',
          nameToken,
        );
      }
      this.expectPunct(')', 'after the entity name');
      entity = String(nameToken.value);
      entityToken = nameToken;
    } else if (first.type === 'identifier' && first.value === 'db') {
      this.next();
      this.expectPunct('.', 'after "db"');
      const nameToken = this.next();
      if (nameToken.type !== 'identifier') {
        this.fail('expected a collection name after "db.", e.g. db.orders', nameToken);
      }
      entity = String(nameToken.value);
      entityToken = nameToken;
    } else {
      this.fail(
        `queries must start with collection("entity") or db.entity — found ${label(first)}`,
        first,
      );
    }

    if (entity.length > MAX_ENTITY_NAME_LENGTH) {
      this.fail(
        `entity name is too long (${entity.length} > ${MAX_ENTITY_NAME_LENGTH} characters)`,
        entityToken,
      );
    }
    if (!ENTITY_NAME_RE.test(entity)) {
      this.fail(
        `invalid entity name "${entity}" — use letters, digits and underscores, starting with a letter or underscore`,
        entityToken,
      );
    }
    return entity;
  }

  private parseMethod(): void {
    const nameToken = this.next();
    if (nameToken.type !== 'identifier') {
      this.fail(`expected a method name after "." but found ${label(nameToken)}`, nameToken);
    }
    const name = String(nameToken.value);

    switch (name) {
      case 'find':
      case 'where':
        this.parseFind(name, nameToken);
        return;
      case 'sort':
        this.parseSort(nameToken);
        return;
      case 'limit':
      case 'skip':
      case 'offset':
        this.parseLimitOrSkip(name, nameToken);
        return;
      case 'select':
        this.parseSelect(nameToken);
        return;
      case 'count':
        this.parseCount(nameToken);
        return;
      default:
        this.fail(`unknown method "${name}"() — supported: ${SUPPORTED_METHODS}`, nameToken);
    }
  }

  // find(objectLiteral?) | where(objectLiteral?)
  private parseFind(name: string, nameToken: Token): void {
    if (this.hasFind) {
      this.fail(
        'duplicate find()/where() — pass all conditions in a single filter object',
        nameToken,
      );
    }
    this.hasFind = true;

    this.expectPunct('(', `after "${name}"`);
    const argToken = this.peek();
    let obj: Record<string, unknown> | undefined;
    if (!this.isPunct(argToken, ')')) {
      if (!this.isPunct(argToken, '{')) {
        this.fail(
          `${name}() requires an object literal argument like { status: "active" }`,
          argToken,
        );
      }
      obj = this.parseObjectLiteral(1);
    }
    this.expectPunct(')', `to close ${name}(...)`);

    if (obj !== undefined) {
      this.filter = this.delegate(() => compileFilterObject(obj, `${name}()`), argToken);
    }
  }

  // sort(objectLiteral) | sort(string, 'asc'|'desc')
  private parseSort(nameToken: Token): void {
    this.expectPunct('(', 'after "sort"');
    const argToken = this.peek();
    let clauses: SortClause[];

    if (argToken.type === 'string') {
      const pathToken = this.next();
      this.expectPunct(',', 'between the sort path and its direction');
      const dirToken = this.next();
      if (dirToken.type !== 'string') {
        this.fail('sort() direction must be the string "asc" or "desc"', dirToken);
      }
      const dir = String(dirToken.value);
      if (dir !== 'asc' && dir !== 'desc') {
        this.fail(`invalid sort direction "${dir}" — use "asc" or "desc"`, dirToken);
      }
      // Computed keys define own properties, so "__proto__" cannot poison the
      // prototype here; compileSortObject still rejects forbidden segments.
      const obj = { [String(pathToken.value)]: dir };
      clauses = this.delegate(() => compileSortObject(obj, 'sort()'), pathToken);
    } else if (this.isPunct(argToken, '{')) {
      const obj = this.parseObjectLiteral(1);
      clauses = this.delegate(() => compileSortObject(obj, 'sort()'), argToken);
    } else {
      this.fail(
        'sort() requires an object like { field: 1 } or two strings like sort("field", "desc")',
        argToken,
      );
    }

    this.expectPunct(')', 'to close sort(...)');
    this.sort.push(...clauses);
    if (this.sort.length > MAX_TOTAL_SORT_FIELDS) {
      this.fail(
        `sort supports at most ${MAX_TOTAL_SORT_FIELDS} fields in total across all sort() calls`,
        nameToken,
      );
    }
  }

  // limit(n) | skip(n) | offset(n)
  private parseLimitOrSkip(name: string, nameToken: Token): void {
    const isLimit = name === 'limit';
    if (isLimit ? this.limit !== undefined : this.offset !== undefined) {
      this.fail(
        isLimit
          ? 'duplicate limit() — limit may be set only once'
          : 'duplicate skip()/offset() — the row offset may be set only once',
        nameToken,
      );
    }

    this.expectPunct('(', `after "${name}"`);
    const argToken = this.next();
    if (argToken.type !== 'number') {
      this.fail(
        `${name}() requires a non-negative integer argument, e.g. ${name}(10) — found ${label(argToken)}`,
        argToken,
      );
    }
    const value = Number(argToken.value);
    if (!Number.isInteger(value) || value < 0) {
      this.fail(`${name}() must be a non-negative integer (got ${value})`, argToken);
    }
    this.expectPunct(')', `to close ${name}(...)`);

    if (isLimit) this.limit = value;
    else this.offset = value;
  }

  // select(objectLiteral) — inclusion projections only
  private parseSelect(nameToken: Token): void {
    if (this.select !== undefined) {
      this.fail('duplicate select() — list all fields in a single select() object', nameToken);
    }

    this.expectPunct('(', 'after "select"');
    const argToken = this.peek();
    if (!this.isPunct(argToken, '{')) {
      this.fail(
        'select() requires an object literal like { name: 1, "customer.city": 1 }',
        argToken,
      );
    }
    const obj = this.parseObjectLiteral(1);
    this.expectPunct(')', 'to close select(...)');

    const entries = Object.entries(obj);
    if (entries.length === 0) {
      this.fail('select() requires at least one field, e.g. select({ name: 1 })', argToken);
    }
    this.select = entries.map(([path, value]) => {
      if (value === 0) {
        this.fail(
          'exclusion projections are not supported — list the fields you want with 1',
          argToken,
        );
      }
      if (value !== 1) {
        this.fail(`invalid select value for "${path}" — use 1 to include a field`, argToken);
      }
      this.delegate(() => assertSafePath(path, 'select()'), argToken);
      return { path, isArrayPath: path.includes('[]') };
    });
  }

  // count() — terminal; only combinable with find/where
  private parseCount(nameToken: Token): void {
    this.expectPunct('(', 'after "count"');
    const argToken = this.peek();
    if (!this.isPunct(argToken, ')')) {
      this.fail('count() takes no arguments', argToken);
    }
    this.next(); // consume ')'

    if (
      this.sort.length > 0 ||
      this.limit !== undefined ||
      this.offset !== undefined ||
      this.select !== undefined
    ) {
      this.fail('count() cannot be combined with sort/limit/skip/select', nameToken);
    }
    this.action = 'count';

    const after = this.peek();
    if (this.isPunct(after, '.')) {
      this.fail('count() must be the last method in the chain', after);
    }
  }

  // ── Literals ─────────────────────────────────────────────

  // objectLiteral := '{' (key ':' value (',' key ':' value)* ','?)? '}'
  private parseObjectLiteral(depth: number): Record<string, unknown> {
    this.expectPunct('{', 'to open an object literal');
    // Null prototype: even if a forbidden key slipped through, assignment
    // could never reach Object.prototype.
    const obj: Record<string, unknown> = Object.create(null);

    if (this.isPunct(this.peek(), '}')) {
      this.next();
      return obj;
    }

    for (;;) {
      const keyToken = this.next();
      if (keyToken.type !== 'identifier' && keyToken.type !== 'string') {
        this.fail(
          `expected a property name (identifier or quoted string) but found ${label(keyToken)}`,
          keyToken,
        );
      }
      const key = String(keyToken.value);
      if (FORBIDDEN_OBJECT_KEYS.has(key)) {
        this.fail(`key "${key}" is not allowed`, keyToken);
      }
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        this.fail(`duplicate key "${key}" in object literal`, keyToken);
      }

      this.expectPunct(':', `after key "${key}"`);
      obj[key] = this.parseValue(depth + 1);

      const t = this.next();
      if (this.isPunct(t, ',')) {
        if (this.isPunct(this.peek(), '}')) {
          this.next(); // trailing comma
          break;
        }
        continue;
      }
      if (this.isPunct(t, '}')) break;
      this.fail(`expected "," or "}" in object literal but found ${label(t)}`, t);
    }
    return obj;
  }

  // arrayLiteral := '[' (value (',' value)* ','?)? ']'
  private parseArrayLiteral(depth: number): unknown[] {
    this.expectPunct('[', 'to open an array literal');
    const arr: unknown[] = [];

    if (this.isPunct(this.peek(), ']')) {
      this.next();
      return arr;
    }

    for (;;) {
      arr.push(this.parseValue(depth + 1));
      const t = this.next();
      if (this.isPunct(t, ',')) {
        if (this.isPunct(this.peek(), ']')) {
          this.next(); // trailing comma
          break;
        }
        continue;
      }
      if (this.isPunct(t, ']')) break;
      this.fail(`expected "," or "]" in array literal but found ${label(t)}`, t);
    }
    return arr;
  }

  // value := string | number | true | false | null | objectLiteral | arrayLiteral
  private parseValue(depth: number): unknown {
    const t = this.peek();
    if (depth > MAX_LITERAL_DEPTH) {
      this.fail(`literal nesting is too deep (max ${MAX_LITERAL_DEPTH} levels)`, t);
    }

    if (t.type === 'string' || t.type === 'number') {
      this.next();
      return t.value;
    }
    if (t.type === 'identifier') {
      this.next();
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      this.fail(
        `unexpected identifier "${t.value}" — only string, number, boolean, null, object and array literals are allowed as values`,
        t,
      );
    }
    if (this.isPunct(t, '{')) return this.parseObjectLiteral(depth);
    if (this.isPunct(t, '[')) return this.parseArrayLiteral(depth);
    this.fail(`expected a value but found ${label(t)}`, t);
  }

  // ── Result ───────────────────────────────────────────────

  private buildResult(entity: string): ParsedJsQuery {
    const query: EntityQuery = { entity };
    if (this.filter !== undefined) query.filter = this.filter;

    if (this.action === 'count') {
      // count queries carry ONLY entity + filter.
      return { entity, action: 'count', query };
    }

    if (this.sort.length > 0) query.sort = this.sort;
    if (this.limit !== undefined) query.limit = this.limit;
    if (this.offset !== undefined) query.offset = this.offset;
    if (this.select !== undefined) query.select = this.select;
    return { entity, action: 'find', query };
  }
}

// ── Entry point ────────────────────────────────────────────

/**
 * Parse SDK-style query text into a validated EntityQuery. Never evaluates
 * the input. Throws JsQueryParseError (a QueryValidationError, HTTP 400) with
 * 1-based line/column on anything outside the closed grammar.
 */
export function parseJsQuery(source: string): ParsedJsQuery {
  if (typeof source !== 'string') {
    throw new JsQueryParseError('query source must be a string', 1, 1);
  }
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new JsQueryParseError(
      `query text is too long (${source.length} > ${MAX_SOURCE_LENGTH} characters)`,
      1,
      1,
    );
  }
  return new Parser(tokenize(source)).parse();
}
