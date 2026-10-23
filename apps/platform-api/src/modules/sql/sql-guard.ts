import { Token, tokenize } from './sql-lexer';

/**
 * Denylist for the SQL route. Defense in depth only — the real isolation is
 * per-project databases + a non-privileged project role; this blocks
 * obviously dangerous statements (role/db/file/program/FDW ops) even if
 * comments try to smuggle them in. A pure function, unit tested on its own.
 *
 * It matches tokens, not text. The first version upper-cased the query and
 * looked for substrings, so "LOAD " was found inside `payload text`,
 * `AS workload` and `'download me'` and those ordinary statements were refused
 * as "Forbidden SQL operation: LOAD". Now:
 *
 *  - keywords match as whole words, never as part of a longer identifier;
 *  - statement keywords that are also ordinary words (COPY, LOAD, REVOKE,
 *    TRUNCATE) only count where a statement can start, so a column called
 *    `load` or `copy` is just a column;
 *  - comments are dropped, so a keyword split by one (`DROP/**​/DATABASE`) is
 *    still the keyword and a keyword inside one never runs;
 *  - string literals and dollar-quoted bodies are still read — that is where
 *    a function body or an EXECUTE would hide a COPY — but as SQL of their
 *    own: a body that runs `COPY t TO PROGRAM` is refused, a value that
 *    merely says "copy that" or "page load" is not.
 */

/** Refused for every caller, the project owner included. */
export const FORBIDDEN_PATTERNS = [
  'DROP DATABASE',
  'DROP ROLE',
  'CREATE ROLE',
  'ALTER ROLE',
  'CREATE DATABASE',
  'COPY',
  'pg_read_file',
  'pg_write_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'lo_import',
  'lo_export',
  'CREATE EXTENSION',
  'LOAD',
  'SET ROLE',
  'SET SESSION AUTHORIZATION',
  'GRANT',
  'REVOKE',
  'ALTER DEFAULT PRIVILEGES',
  'CREATE USER',
  'ALTER USER',
  'DROP USER',
  'CREATE TABLESPACE',
  'ALTER SYSTEM',
  // Server-side file/program/foreign-data access.
  'PG_READ_SERVER_FILES',
  'PG_WRITE_SERVER_FILES',
  'PG_EXECUTE_SERVER_PROGRAM',
  'DBLINK',
  'CREATE FOREIGN',
  'CREATE SERVER',
  'CREATE PUBLICATION',
  'CREATE SUBSCRIPTION',
] as const;

/**
 * Statements refused when the caller is not the project's owner.
 *
 * These are absent from the list above on purpose: the SQL editor is how a
 * project owner shapes their schema, so DDL has to work there. What must not
 * work is the same statement arriving on the public anon key. Postgres grants
 * should already stop it, but this file exists because grants are one layer
 * and a misgranted role would otherwise have no second one.
 *
 * The policy verbs matter most. An anon caller who can run ALTER POLICY or
 * ALTER TABLE ... DISABLE ROW LEVEL SECURITY takes the lid off the very
 * mechanism that bounds them, and CREATE FUNCTION lets them write a
 * SECURITY DEFINER function and call it back through rpc to run as the owner.
 */
export const OWNER_ONLY_PATTERNS = [
  'CREATE TABLE',
  'ALTER TABLE',
  'DROP TABLE',
  'TRUNCATE',
  'CREATE SCHEMA',
  'DROP SCHEMA',
  'ALTER SCHEMA',
  'CREATE INDEX',
  'DROP INDEX',
  'CREATE VIEW',
  'ALTER VIEW',
  'DROP VIEW',
  'CREATE MATERIALIZED VIEW',
  'CREATE POLICY',
  'ALTER POLICY',
  'DROP POLICY',
  'ROW LEVEL SECURITY',
  'CREATE FUNCTION',
  'CREATE OR REPLACE FUNCTION',
  'DROP FUNCTION',
  'CREATE PROCEDURE',
  'CREATE TRIGGER',
  'DROP TRIGGER',
  'CREATE SEQUENCE',
  'ALTER SEQUENCE',
  'CREATE TYPE',
  'DROP TYPE',
  'SECURITY DEFINER',
  'SET LOCAL ROLE',
  'SET request.jwt.*',
] as const;

/**
 * Who is running the statement.
 *
 * 'owner' is a dashboard team member in the SQL editor. The others are the
 * Postgres role an API-key call runs as: 'service_role' holds the project's
 * secret key and is treated as administrative, while 'anon' and
 * 'authenticated' arrive over a key that ships in a browser.
 */
export type SqlCallerRole = 'owner' | 'service_role' | 'authenticated' | 'anon';

// ── Token streams ───────────────────────────────────────────────────────────

/**
 * One normalised symbol per token: words upper-cased, a quoted identifier as
 * `"NAME"` (spaces folded so it stays one symbol), every string as `'`,
 * numbers as `0`. Strings are kept beside the stream so their contents can be
 * read as SQL of their own.
 */
interface Stream {
  symbols: string[];
  strings: Map<number, Token>;
  /** True for the contents of a string literal or dollar-quoted body. */
  literal: boolean;
}

const MAX_LITERAL_DEPTH = 3;

function toStream(tokens: Token[], literal: boolean): Stream {
  const symbols: string[] = [];
  const strings = new Map<number, Token>();
  for (const t of tokens) {
    switch (t.type) {
      case 'word':
        symbols.push(t.upper);
        break;
      case 'qident':
        symbols.push(`"${t.value.toUpperCase().replace(/\s+/g, '_')}"`);
        break;
      case 'string':
        strings.set(symbols.length, t);
        symbols.push("'");
        break;
      case 'number':
        symbols.push('0');
        break;
      case 'param':
        symbols.push('$');
        break;
      default:
        symbols.push(t.value);
    }
  }
  return { symbols, strings, literal };
}

/**
 * Statements whose string arguments are executed as SQL: a function body, a
 * DO block, a prepared or dynamically executed statement.
 *
 * Everywhere else a string is data. Reading every string as code refused
 * ordinary rows — `INSERT INTO i18n VALUES ('copy_btn', 'Copy to clipboard')`
 * came back as "Forbidden SQL operation: COPY", and a note saying "reset role"
 * or "discard all" was refused the same way. Customers store text about
 * software; the guard has to tell a function body from a sentence.
 */
const EXECUTABLE_STRING_HEADS = new Set(['DO', 'EXECUTE', 'PREPARE', 'CREATE', 'ALTER', 'REFRESH']);

/** The query itself, then the contents of any literal that will be run as SQL. */
function streamsOf(query: string): Stream[] {
  const out: Stream[] = [];
  const visit = (tokens: Token[], literal: boolean, depth: number) => {
    const stream = toStream(tokens, literal);
    out.push(stream);
    if (depth >= MAX_LITERAL_DEPTH) return;
    for (const [at, t] of stream.strings) {
      if (t.quote === 'bit' || !t.value.trim()) continue;
      const head = statementHead(stream.symbols, at, literal);
      if (!head || !EXECUTABLE_STRING_HEADS.has(bareName(head))) continue;
      visit(tokenize(t.value), true, depth + 1);
    }
  };
  visit(tokenize(query), false, 0);
  return out;
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Compile "CREATE [OR REPLACE] [TEMP|TEMPORARY] TABLE" into a regex over a
 * stream joined with single spaces. `[a|b c]` is an optional group of
 * alternatives and `{a|b}` a required one; an alternative may be several
 * words. Patterns start with a plain word.
 */
function compile(pattern: string): RegExp {
  const parts: string[] = [];
  const re = /\[([^\]]+)\]|\{([^}]+)\}|(\S+)/g;
  const alternatives = (group: string) =>
    group.split('|').map((a) => a.trim().split(/\s+/).map(escape).join(' ')).join('|');
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern))) {
    if (m[1]) parts.push(`(?: (?:${alternatives(m[1])}))?`);
    else if (m[2]) parts.push(` (?:${alternatives(m[2])})`);
    else parts.push(`${parts.length ? ' ' : ''}${escape(m[3])}`);
  }
  return new RegExp(`(?:^| )${parts.join('')}(?= |$)`);
}

function escape(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word sequences refused anywhere they occur, for every caller. */
const FORBIDDEN_SEQUENCES: Array<[label: string, re: RegExp]> = [
  ['DROP DATABASE', compile('DROP DATABASE')],
  ['CREATE DATABASE', compile('CREATE DATABASE')],
  ['DROP ROLE', compile('DROP ROLE')],
  ['CREATE ROLE', compile('CREATE ROLE')],
  ['ALTER ROLE', compile('ALTER ROLE')],
  ['CREATE USER', compile('CREATE USER')],
  ['ALTER USER', compile('ALTER USER')],
  ['DROP USER', compile('DROP USER')],
  ['CREATE TABLESPACE', compile('CREATE TABLESPACE')],
  ['ALTER SYSTEM', compile('ALTER SYSTEM')],
  ['CREATE EXTENSION', compile('CREATE EXTENSION')],
  ['CREATE FOREIGN', compile('CREATE FOREIGN')],
  ['CREATE SERVER', compile('CREATE SERVER')],
  ['CREATE PUBLICATION', compile('CREATE PUBLICATION')],
  ['CREATE SUBSCRIPTION', compile('CREATE SUBSCRIPTION')],
  ['ALTER DEFAULT PRIVILEGES', compile('ALTER DEFAULT PRIVILEGES')],
];

/** Functions and built-in roles that reach the server's files or programs. */
const FORBIDDEN_NAMES = new Map<string, string>([
  ['PG_READ_FILE', 'pg_read_file'],
  ['PG_WRITE_FILE', 'pg_write_file'],
  ['PG_READ_BINARY_FILE', 'pg_read_binary_file'],
  ['PG_LS_DIR', 'pg_ls_dir'],
  ['PG_STAT_FILE', 'pg_stat_file'],
  ['LO_IMPORT', 'lo_import'],
  ['LO_EXPORT', 'lo_export'],
  ['PG_READ_SERVER_FILES', 'PG_READ_SERVER_FILES'],
  ['PG_WRITE_SERVER_FILES', 'PG_WRITE_SERVER_FILES'],
  ['PG_EXECUTE_SERVER_PROGRAM', 'PG_EXECUTE_SERVER_PROGRAM'],
]);

/** Word sequences refused anywhere for callers that are not the owner. */
const OWNER_ONLY_SEQUENCES: Array<[label: string, re: RegExp]> = [
  ['CREATE TABLE', compile('CREATE [OR REPLACE] [GLOBAL|LOCAL] [TEMP|TEMPORARY|UNLOGGED] TABLE')],
  ['ALTER TABLE', compile('ALTER TABLE')],
  ['DROP TABLE', compile('DROP TABLE')],
  ['CREATE SCHEMA', compile('CREATE SCHEMA')],
  ['DROP SCHEMA', compile('DROP SCHEMA')],
  ['ALTER SCHEMA', compile('ALTER SCHEMA')],
  ['CREATE INDEX', compile('CREATE [UNIQUE] INDEX')],
  ['DROP INDEX', compile('DROP INDEX')],
  ['CREATE VIEW', compile('CREATE [OR REPLACE] [TEMP|TEMPORARY] [RECURSIVE] VIEW')],
  ['ALTER VIEW', compile('ALTER VIEW')],
  ['DROP VIEW', compile('DROP VIEW')],
  ['CREATE MATERIALIZED VIEW', compile('CREATE MATERIALIZED VIEW')],
  ['CREATE POLICY', compile('CREATE POLICY')],
  ['ALTER POLICY', compile('ALTER POLICY')],
  ['DROP POLICY', compile('DROP POLICY')],
  ['ROW LEVEL SECURITY', compile('ROW LEVEL SECURITY')],
  ['CREATE OR REPLACE FUNCTION', compile('CREATE OR REPLACE FUNCTION')],
  ['CREATE FUNCTION', compile('CREATE FUNCTION')],
  ['DROP FUNCTION', compile('DROP FUNCTION')],
  ['CREATE PROCEDURE', compile('CREATE [OR REPLACE] PROCEDURE')],
  ['CREATE TRIGGER', compile('CREATE [OR REPLACE] [CONSTRAINT] TRIGGER')],
  ['DROP TRIGGER', compile('DROP TRIGGER')],
  ['CREATE SEQUENCE', compile('CREATE [TEMP|TEMPORARY|UNLOGGED] SEQUENCE')],
  ['ALTER SEQUENCE', compile('ALTER SEQUENCE')],
  ['CREATE TYPE', compile('CREATE TYPE')],
  ['DROP TYPE', compile('DROP TYPE')],
  ['SECURITY DEFINER', compile('SECURITY DEFINER')],
];

/**
 * Where a statement can begin: the start of the text, after `;`, after BEGIN
 * ATOMIC — and, inside a literal (a function body), after the PL/pgSQL words
 * that open a block, a branch or a loop. Those words are not openers in plain
 * SQL, where `CASE WHEN … THEN load …` names a column.
 */
const CODE_OPENERS = new Set([';', 'ATOMIC']);
const BODY_OPENERS = new Set([';', 'ATOMIC', 'BEGIN', 'THEN', 'ELSE', 'LOOP', '>>']);

function openers(literal: boolean): Set<string> {
  return literal ? BODY_OPENERS : CODE_OPENERS;
}

function atStatementStart(symbols: string[], i: number, literal: boolean): boolean {
  return i === 0 || openers(literal).has(symbols[i - 1]);
}

/** Does `want` occur after position `i`, before the statement ends? */
function laterInStatement(symbols: string[], i: number, want: string[]): boolean {
  for (let k = i + 1; k < symbols.length && symbols[k] !== ';'; k++) {
    if (want.includes(symbols[k])) return true;
  }
  return false;
}

/**
 * `set_config('role', …)` is SET ROLE by another name. With `true` as its third
 * argument it is transaction-local, like SET LOCAL ROLE.
 */
function setConfigRole(stream: Stream, i: number): 'session' | 'local' | null {
  const { symbols, strings } = stream;
  if (symbols[i] !== 'SET_CONFIG' && symbols[i] !== '"SET_CONFIG"') return null;
  if (symbols[i + 1] !== '(') return null;
  const name = strings.get(i + 2)?.value.trim().toLowerCase();
  if (name !== 'role' && name !== 'session_authorization') return null;
  if (name === 'session_authorization') return 'session';
  let depth = 0;
  for (let k = i + 1; k < symbols.length; k++) {
    if (symbols[k] === '(') depth++;
    else if (symbols[k] === ')') {
      depth--;
      if (depth === 0) return symbols[k - 1] === 'TRUE' ? 'local' : 'session';
    }
  }
  return 'session';
}

/**
 * The run-time settings that carry the caller's identity.
 *
 * auth.uid() and auth.jwt() read request.jwt.claims (and the per-claim
 * request.jwt.claim.* keys) — ordinary Postgres settings that the server fills
 * in from the verified token before it runs a caller's SQL. They are what
 * row-level security policies compare against, so SQL that can write them can
 * name whichever user it likes and read that user's rows.
 *
 * The server sets them on its own connection, outside anything this guard
 * sees, so refusing them here costs the platform nothing. The project owner
 * keeps the ability, because trying a policy as some user is what the SQL
 * editor is for.
 */
const IDENTITY_SETTING_PREFIX = 'REQUEST';
const IDENTITY_SETTING_SECOND = 'JWT';

/**
 * `SET [LOCAL|SESSION] request.jwt.claims = …`, as a command.
 *
 * The assignment has to be there. Setting a run-time parameter is always
 * `SET name = value` or `SET name TO value`, so requiring it costs nothing in
 * real SQL and keeps prose out of the net: a row whose text happens to read
 * "set request.jwt.claims" is data, and the literal recursion would otherwise
 * refuse the INSERT that stores it.
 */
function setsIdentitySetting(symbols: string[], i: number, literal: boolean): boolean {
  if (symbols[i] !== 'SET') return false;
  const head = statementHead(symbols, i, literal);
  if (!atStatementStart(symbols, i, literal) && head !== 'CREATE' && head !== 'ALTER') return false;
  let k = i + 1;
  if (symbols[k] === 'SESSION' || symbols[k] === 'LOCAL') k++;
  if (
    bareName(symbols[k] ?? '') !== IDENTITY_SETTING_PREFIX ||
    symbols[k + 1] !== '.' ||
    bareName(symbols[k + 2] ?? '') !== IDENTITY_SETTING_SECOND
  ) {
    return false;
  }
  // Step over the rest of a dotted parameter name, then insist on a value.
  let j = k + 3;
  while (symbols[j] === '.' && symbols[j + 1] !== undefined) j += 2;
  return symbols[j] === '=' || symbols[j] === 'TO';
}

/** `set_config('request.jwt.claims', …)` — the same write, as a function call. */
function setConfigIdentitySetting(stream: Stream, i: number): boolean {
  const { symbols, strings } = stream;
  if (symbols[i] !== 'SET_CONFIG' && symbols[i] !== '"SET_CONFIG"') return false;
  if (symbols[i + 1] !== '(') return false;
  const name = strings.get(i + 2)?.value.trim().toLowerCase();
  return !!name && (name === 'request.jwt' || name.startsWith('request.jwt.'));
}

function bareName(symbol: string): string {
  return symbol.startsWith('"') ? symbol.slice(1, -1) : symbol;
}

/** First symbol of the statement that contains position `i`. */
function statementHead(symbols: string[], i: number, literal: boolean): string | undefined {
  const open = openers(literal);
  let k = i;
  while (k > 0 && !open.has(symbols[k - 1])) k--;
  return symbols[k];
}

/**
 * The SET command when it changes who the session is: SET [SESSION | LOCAL]
 * ROLE, SET … SESSION AUTHORIZATION (or its GUC spelling). Only the command
 * counts — `UPDATE users SET role = 'admin'` assigns a column called role —
 * so SET must open the statement, or sit in the configuration clause of a
 * CREATE / ALTER (`CREATE FUNCTION … SET role = …`).
 */
function setRoleCommand(
  symbols: string[],
  i: number,
  literal: boolean,
): 'session' | 'local' | 'authorization' | null {
  if (symbols[i] !== 'SET') return null;
  const head = statementHead(symbols, i, literal);
  if (!atStatementStart(symbols, i, literal) && head !== 'CREATE' && head !== 'ALTER') return null;
  let k = i + 1;
  let scope: 'SESSION' | 'LOCAL' | null = null;
  if (symbols[k] === 'SESSION' && symbols[k + 1] !== 'AUTHORIZATION') {
    scope = 'SESSION';
    k++;
  } else if (symbols[k] === 'LOCAL') {
    scope = 'LOCAL';
    k++;
  }
  const what = bareName(symbols[k] ?? '');
  if (what === 'ROLE') return scope === 'LOCAL' ? 'local' : 'session';
  if (what === 'SESSION_AUTHORIZATION') return 'authorization';
  if (what === 'SESSION' && symbols[k + 1] === 'AUTHORIZATION') return 'authorization';
  return null;
}

/**
 * What a key that ships in a browser may run at all.
 *
 * Listing everything such a caller must not do turned out to be unwinnable:
 * every statement that changes who the session is has a second spelling, and
 * the ones that were missed — RESET ROLE, RESET ALL, DISCARD, a bare COMMIT
 * that ends the transaction the role was bound in, a DO block that builds its
 * SQL at run time — each put the caller back on the project owner for the rest
 * of the request. Naming what is allowed instead cannot be out-spelled.
 *
 * It costs nothing: across 30 days and 728,946 key-authenticated statements,
 * every one began with SELECT, WITH, INSERT, UPDATE or DELETE, except four
 * from the account that reported this. Schema work goes through the dashboard
 * or the secret key, which are not bound by this list.
 */
const CALLER_STATEMENTS = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'VALUES',
  'TABLE',
  'EXPLAIN',
]);

/** The first statement in the script that a browser-key caller may not run. */
function firstStatementOutsideAllowlist(symbols: string[]): string | null {
  let atStart = true;
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    if (s === ';') {
      atStart = true;
      continue;
    }
    if (!atStart) continue;
    // A statement may open with parentheses: (SELECT …) UNION (SELECT …).
    if (s === '(') continue;
    atStart = false;
    const word = bareName(s);
    if (!CALLER_STATEMENTS.has(word)) return word;
  }
  return null;
}

function checkForbidden(stream: Stream): string | null {
  const { symbols, literal } = stream;
  const joined = symbols.join(' ');
  for (const [label, re] of FORBIDDEN_SEQUENCES) {
    if (re.test(joined)) return label;
  }

  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    const name = bareName(s);
    const fn = FORBIDDEN_NAMES.get(name);
    if (fn) return fn;
    if (name.startsWith('DBLINK')) return 'DBLINK';

    const set = setRoleCommand(symbols, i, literal);
    if (set === 'session') return 'SET ROLE';
    if (set === 'authorization') return 'SET SESSION AUTHORIZATION';
    const viaFunction = setConfigRole(stream, i);
    if (viaFunction === 'session') return 'SET ROLE';

    const start = atStatementStart(symbols, i, literal);
    switch (s) {
      case 'COPY':
        // COPY is a statement, so it only ever runs from where one starts. In
        // code that is the whole rule; inside a literal it must also look like
        // one (a table or query, then FROM/TO), so "copy that" is just text.
        if (start && (!literal || symbols[i + 1] === '(' || laterInStatement(symbols, i, ['FROM', 'TO']))) {
          return 'COPY';
        }
        break;
      case 'LOAD':
        // LOAD 'library' — always followed by a string.
        if (start && (!literal || symbols[i + 1] === "'")) return 'LOAD';
        break;
      case 'GRANT':
        // A reserved word: in code it cannot be anything but GRANT. In a
        // literal it needs the rest of the statement (… ON / TO …).
        if (!literal || laterInStatement(symbols, i, ['TO', 'ON'])) return 'GRANT';
        break;
      case 'REVOKE':
        // Not reserved — `revoke` can name a column — so only the command.
        if (start && (!literal || laterInStatement(symbols, i, ['FROM']))) return 'REVOKE';
        break;
      default:
        break;
    }
  }
  return null;
}

function checkOwnerOnly(stream: Stream): string | null {
  const { symbols, literal } = stream;
  const joined = symbols.join(' ');
  for (const [label, re] of OWNER_ONLY_SEQUENCES) {
    if (re.test(joined)) return label;
  }
  for (let i = 0; i < symbols.length; i++) {
    if (setRoleCommand(symbols, i, literal) === 'local') return 'SET LOCAL ROLE';
    if (setConfigRole(stream, i) === 'local') return 'SET LOCAL ROLE';
    if (setsIdentitySetting(symbols, i, literal)) return 'SET request.jwt.*';
    if (setConfigIdentitySetting(stream, i)) return 'SET request.jwt.*';
    if (symbols[i] === 'TRUNCATE' && (!literal || atStatementStart(symbols, i, literal))) return 'TRUNCATE';
  }
  return null;
}

/**
 * Returns the first forbidden operation found in `query`, or null if the
 * query is allowed.
 *
 * `role` decides whether the owner-only list applies as well; it defaults to
 * the stricter reading, so a caller that forgets to pass it gets the narrower
 * permission rather than the wider one.
 */
export function findForbiddenSqlPattern(
  query: string,
  role: SqlCallerRole = 'anon',
): string | null {
  const streams = streamsOf(query);
  for (const stream of streams) {
    const hit = checkForbidden(stream);
    if (hit) return hit;
  }
  if (role !== 'owner' && role !== 'service_role') {
    const outside = firstStatementOutsideAllowlist(streams[0].symbols);
    if (outside) {
      return `${outside} on a public key. This key may only run SELECT, WITH, INSERT, UPDATE, DELETE, VALUES, TABLE and EXPLAIN; schema and session changes need the service key or the dashboard`;
    }
    for (const stream of streams) {
      const hit = checkOwnerOnly(stream);
      if (hit) return hit;
    }
  }
  return null;
}
