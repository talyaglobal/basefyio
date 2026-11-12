/**
 * Pure SQL analysis for the AI assistant.
 *
 * The assistant may run what it writes only when the statement cannot change
 * anything. Everything else becomes a proposal the person approves first. This
 * file decides which is which, splits scripts into statements, and works out
 * what to check in the catalog after an approved change ran, so the assistant
 * reports what the database says rather than what it hoped for.
 *
 * The classification is the first of two layers: read statements still run
 * inside a READ ONLY transaction, so a misclassified write fails instead of
 * writing.
 */

export type StatementKind =
  /** Cannot change data or schema: SELECT, WITH (no data-modifying CTE), EXPLAIN, SHOW, TABLE, VALUES. */
  | 'read'
  /** Changes rows: INSERT, UPDATE, DELETE, MERGE, CALL, COPY, REFRESH, LOCK. */
  | 'write'
  /** Changes the schema or security: CREATE, ALTER, COMMENT, GRANT, REVOKE, DO blocks. */
  | 'schema'
  /** Transaction control; basefyio wraps approved scripts in its own transaction. */
  | 'transaction'
  /** Anything else (SET, VACUUM, LISTEN …) — treated like a change. */
  | 'other';

export interface AnalyzedStatement {
  sql: string;
  kind: StatementKind;
  /** First keyword(s), upper case — "CREATE TABLE", "DELETE", "ALTER TABLE". */
  command: string;
  /** Removes data or weakens protection: DROP, TRUNCATE, unfiltered DELETE/UPDATE, DISABLE RLS … */
  destructive: boolean;
  /** One-line reason shown next to a destructive statement. */
  warning: string | null;
}

/**
 * Split a script into statements on top-level semicolons, respecting quotes,
 * dollar quoting and comments. Comment-only fragments are dropped; each
 * statement comes back trimmed and without its terminating semicolon.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = script.length;

  const push = (end: number) => {
    const piece = script.slice(start, end).trim();
    if (piece && stripComments(piece).trim()) out.push(piece);
  };

  while (i < n) {
    const ch = script[i];
    const next = script[i + 1];

    if (ch === '-' && next === '-') {
      const nl = script.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // Postgres block comments nest.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (script[i] === '/' && script[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (script[i] === '*' && script[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === "'") {
      // E'...' strings honour backslash escapes; standard strings only ''.
      const escaped = i > 0 && /[eE]/.test(script[i - 1]) && (i < 2 || !/\w/.test(script[i - 2]));
      i++;
      while (i < n) {
        if (escaped && script[i] === '\\') {
          i += 2;
          continue;
        }
        if (script[i] === "'") {
          if (script[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (script[i] === '"') {
          if (script[i + 1] === '"') {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i));
      // A dollar quote cannot follow an identifier character ($1 is a parameter, a$b a name).
      if (m && !(i > 0 && /[\w$]/.test(script[i - 1]))) {
        const tag = m[0];
        const close = script.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(n);
  return out;
}

/** Remove comments (outside of string literals the caller has already masked, or plainly). */
export function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * The statement with comments, string literals, quoted identifiers and dollar
 * bodies replaced by blanks, upper-cased and whitespace-collapsed — what the
 * keyword checks below look at, so a word inside a string never counts.
 */
export function maskForKeywords(sql: string): string {
  let s = sql.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' $$ ');
  s = stripComments(s);
  s = s.replace(/'(?:[^']|'')*'/g, " '' ");
  s = s.replace(/"(?:[^"]|"")*"/g, ' "" ');
  return s.replace(/\s+/g, ' ').trim().toUpperCase();
}

const READ_LEADS = new Set(['SELECT', 'WITH', 'SHOW', 'TABLE', 'VALUES', 'EXPLAIN']);
const WRITE_LEADS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'CALL',
  'COPY',
  'REFRESH',
  'LOCK',
  'TRUNCATE',
]);
const SCHEMA_LEADS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'COMMENT',
  'GRANT',
  'REVOKE',
  'DO',
  'SECURITY',
  'REINDEX',
  'CLUSTER',
  'IMPORT',
]);
const TX_LEADS = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
  'PREPARE',
]);

/** Classify one statement (as returned by splitStatements). */
export function analyzeStatement(sql: string): AnalyzedStatement {
  const masked = maskForKeywords(sql);
  const words = masked.split(' ').filter(Boolean);
  const lead = (words[0] ?? '').replace(/[^A-Z]/g, '');
  const second = (words[1] ?? '').replace(/[^A-Z]/g, '');

  let kind: StatementKind;
  if (READ_LEADS.has(lead)) {
    kind = 'read';
    // WITH … (INSERT|UPDATE|DELETE|MERGE) is a data-modifying CTE.
    if (lead === 'WITH' && /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(masked)) kind = 'write';
    // SELECT … INTO new_table creates a table.
    if (lead === 'SELECT' && /\bINTO\b/.test(masked) && !/\bINTO\s+STRICT\b/.test(masked)) kind = 'schema';
    // EXPLAIN ANALYZE executes the statement it explains.
    if (lead === 'EXPLAIN' && /\bANALY[SZ]E\b/.test(masked)) {
      const rest = masked.replace(/^EXPLAIN\s*(\([^)]*\))?\s*(ANALY[SZ]E\s*)?(VERBOSE\s*)?/, '');
      kind = analyzeStatement(rest || 'SELECT').kind === 'read' ? 'read' : 'write';
    }
    if (/\bFOR\s+(UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/.test(masked)) kind = 'write';
  } else if (WRITE_LEADS.has(lead)) {
    kind = 'write';
  } else if (SCHEMA_LEADS.has(lead)) {
    kind = 'schema';
  } else if (TX_LEADS.has(lead) || (lead === 'SET' && second === 'TRANSACTION')) {
    kind = 'transaction';
  } else {
    kind = 'other';
  }

  const command = commandOf(words);
  const { destructive, warning } = destructiveness(masked, lead);
  return { sql, kind, command, destructive, warning };
}

function commandOf(words: string[]): string {
  const clean = words.map((w) => w.replace(/[^A-Z]/g, ''));
  const lead = clean[0] ?? '';
  if (['CREATE', 'ALTER', 'DROP'].includes(lead)) {
    // Skip modifiers so "CREATE UNIQUE INDEX" and "CREATE OR REPLACE FUNCTION"
    // name the object kind.
    const skip = new Set(['OR', 'REPLACE', 'UNIQUE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'MATERIALIZED', 'GLOBAL', 'LOCAL']);
    const rest = clean.slice(1).filter((w) => !skip.has(w));
    const obj = rest[0] ?? '';
    const materialized = clean.includes('MATERIALIZED') && obj === 'VIEW';
    return `${lead} ${materialized ? 'MATERIALIZED VIEW' : obj}`.trim();
  }
  return lead;
}

function destructiveness(masked: string, lead: string): { destructive: boolean; warning: string | null } {
  if (lead === 'DROP') {
    return { destructive: true, warning: 'Drops a database object and everything stored in it.' };
  }
  if (lead === 'TRUNCATE') {
    return { destructive: true, warning: 'Deletes every row in the table.' };
  }
  if (lead === 'DELETE' && !/\bWHERE\b/.test(masked)) {
    return { destructive: true, warning: 'DELETE without WHERE removes every row in the table.' };
  }
  if (lead === 'UPDATE' && !/\bWHERE\b/.test(masked)) {
    return { destructive: true, warning: 'UPDATE without WHERE changes every row in the table.' };
  }
  if (lead === 'DELETE') {
    return { destructive: true, warning: 'Deletes rows.' };
  }
  if (lead === 'ALTER') {
    if (/\bDROP\s+(COLUMN|CONSTRAINT)\b/.test(masked) || /\bALTER TABLE\b.*\bDROP\b/.test(masked)) {
      return { destructive: true, warning: 'Drops a column or constraint; data in a dropped column is lost.' };
    }
    if (/\b(DISABLE|NO FORCE)\s+ROW LEVEL SECURITY\b/.test(masked)) {
      return { destructive: true, warning: 'Turns row level security off, which exposes every row to the API keys.' };
    }
    if (/\bALTER\s+COLUMN\b.*\bTYPE\b/.test(masked)) {
      return { destructive: true, warning: 'Changes a column type; values that do not convert are rejected or altered.' };
    }
  }
  // A public read policy is a normal choice; a write policy that admits every
  // row hands the table to anyone holding the anon key.
  if (
    /\bCREATE\s+POLICY\b/.test(masked) &&
    !/\bFOR\s+SELECT\b/.test(masked) &&
    /\b(USING|WITH CHECK)\s*\(\s*TRUE\s*\)/.test(masked)
  ) {
    return { destructive: true, warning: 'This policy lets anyone write every row (USING/WITH CHECK true).' };
  }
  return { destructive: false, warning: null };
}

/**
 * Read-only blocks run without asking. A block is read-only only when every
 * statement in it is.
 */
export function isReadOnlyScript(statements: AnalyzedStatement[]): boolean {
  return statements.length > 0 && statements.every((s) => s.kind === 'read');
}

/** Pull ```sql fenced blocks out of a model reply. */
export function extractSqlBlocks(text: string): string[] {
  const regex = /```(?:sql|postgres|postgresql|pgsql|psql)[^\n]*\n([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const sql = match[1].trim();
    if (sql) blocks.push(sql);
  }
  return blocks;
}

/**
 * Prepare a proposal's statements: BEGIN/COMMIT wrappers the model likes to add
 * are dropped (basefyio runs the script in one transaction itself); any other
 * transaction control is refused, because a ROLLBACK or SAVEPOINT in the
 * middle would break that transaction.
 */
export function normalizeProposal(script: string): {
  statements: AnalyzedStatement[];
  error: string | null;
} {
  const all = splitStatements(script).map(analyzeStatement);
  const statements: AnalyzedStatement[] = [];
  for (const s of all) {
    if (s.kind === 'transaction') {
      if (['BEGIN', 'START', 'COMMIT', 'END'].includes(s.command)) continue;
      return {
        statements: [],
        error: `${s.command} cannot be part of an approved change: basefyio runs the whole script in one transaction and rolls it back on any error.`,
      };
    }
    statements.push(s);
  }
  if (!statements.length) return { statements, error: 'The script contains no statements.' };
  return { statements, error: null };
}

/* ─────────────────────────── verification targets ─────────────────────────── */

/** A schema-qualified name as Postgres would resolve it: quoted parts keep case. */
export interface QualifiedName {
  schema: string | null;
  name: string;
}

export type VerificationTarget =
  | { type: 'relation_exists'; relation: QualifiedName; label: string }
  | { type: 'relation_absent'; relation: QualifiedName; label: string }
  | { type: 'rls_enabled'; relation: QualifiedName; enabled: boolean }
  | { type: 'policy_exists'; policy: string; relation: QualifiedName }
  | { type: 'policy_absent'; policy: string; relation: QualifiedName }
  | { type: 'column_exists'; relation: QualifiedName; column: string }
  | { type: 'column_absent'; relation: QualifiedName; column: string }
  | { type: 'function_exists'; fn: QualifiedName };

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;

function unquote(part: string): string {
  const p = part.trim();
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1).replace(/""/g, '"');
  return p.toLowerCase();
}

export function parseQualifiedName(raw: string): QualifiedName {
  const parts: string[] = [];
  const re = new RegExp(IDENT, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) parts.push(unquote(m[0]));
  if (parts.length >= 2) return { schema: parts[0], name: parts[1] };
  return { schema: null, name: parts[0] ?? '' };
}

/** `"schema"."name"` — the text form to_regclass() accepts, with case kept. */
export function quoteQualified(q: QualifiedName): string {
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return q.schema ? `${quote(q.schema)}.${quote(q.name)}` : quote(q.name);
}

/**
 * What to look up in the catalog after `sql` ran, so the outcome reported to
 * the person is what Postgres holds, not what the statement intended.
 * Statements with nothing specific to check return an empty list; their row
 * counts come from the execution result itself.
 */
export function verificationTargets(sql: string): VerificationTarget[] {
  const text = stripComments(sql).replace(/\s+/g, ' ').trim();
  const ci = (pattern: string) => new RegExp(pattern, 'i');
  let m: RegExpExecArray | null;

  if ((m = ci(String.raw`^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP|TEMPORARY|UNLOGGED\s+)?\s*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`).exec(text))) {
    return [{ type: 'relation_exists', relation: parseQualifiedName(m[1]), label: 'table' }];
  }
  if ((m = ci(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}\s+ON\b`).exec(text))) {
    // An index lives in its table's schema; an unqualified name resolves via search_path.
    return [{ type: 'relation_exists', relation: parseQualifiedName(m[1]), label: 'index' }];
  }
  if ((m = ci(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${QNAME}`).exec(text))) {
    return [{ type: 'relation_exists', relation: parseQualifiedName(m[1]), label: 'view' }];
  }
  if ((m = ci(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QNAME}\s*\(`).exec(text))) {
    return [{ type: 'function_exists', fn: parseQualifiedName(m[1]) }];
  }
  if ((m = ci(String.raw`^CREATE\s+POLICY\s+(${IDENT})\s+ON\s+${QNAME}`).exec(text))) {
    return [{ type: 'policy_exists', policy: unquote(m[1]), relation: parseQualifiedName(m[2]) }];
  }
  if ((m = ci(String.raw`^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?(${IDENT})\s+ON\s+${QNAME}`).exec(text))) {
    return [{ type: 'policy_absent', policy: unquote(m[1]), relation: parseQualifiedName(m[2]) }];
  }
  if ((m = ci(String.raw`^DROP\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(.+?)(?:\s+(?:CASCADE|RESTRICT))?$`).exec(text))) {
    return m[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => ({ type: 'relation_absent' as const, relation: parseQualifiedName(part), label: 'object' }));
  }
  if ((m = ci(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QNAME}\s+(.*)$`).exec(text))) {
    const relation = parseQualifiedName(m[1]);
    const rest = m[2];
    const targets: VerificationTarget[] = [];
    if (/\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(rest)) targets.push({ type: 'rls_enabled', relation, enabled: true });
    if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(rest)) targets.push({ type: 'rls_enabled', relation, enabled: false });
    const addCol = new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})\s+(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b)`, 'gi');
    while ((m = addCol.exec(rest)) !== null) {
      const col = unquote(m[1]);
      if (!['constraint', 'primary', 'unique', 'foreign', 'check', 'exclude'].includes(col)) {
        targets.push({ type: 'column_exists', relation, column: col });
      }
    }
    const dropCol = new RegExp(String.raw`\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(${IDENT})`, 'gi');
    while ((m = dropCol.exec(rest)) !== null) {
      targets.push({ type: 'column_absent', relation, column: unquote(m[1]) });
    }
    return targets;
  }
  return [];
}
