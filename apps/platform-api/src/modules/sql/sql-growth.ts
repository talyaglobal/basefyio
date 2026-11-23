import { Token, classifyStatement, splitStatements, tokenize } from './sql-lexer';

/**
 * Does a SQL script add data or schema to the database?
 *
 * Used by the database-size limit: past the limit, a script that grows the
 * database is refused while one that reads or frees space still runs, so a
 * customer can always look at their data and delete it. Deliberately simple
 * and on the side of letting things through:
 *
 *  - reads (SELECT / VALUES / TABLE / WITH … SELECT without INSERT/UPDATE),
 *    DELETE, TRUNCATE, DROP, VACUUM, ANALYZE, REINDEX, CLUSTER, EXPLAIN
 *    (without ANALYZE of a write) and session / transaction statements do not;
 *  - INSERT, UPDATE, MERGE, CREATE, ALTER, COPY, DO, CALL, SELECT … INTO and
 *    anything not listed do.
 *
 * Known gap, documented: a SELECT that calls a function which itself writes.
 */
const SHRINK_OR_READ = new Set([
  'DELETE',
  'TRUNCATE',
  'DROP',
  'VACUUM',
  'ANALYZE',
  'ANALYSE',
  'REINDEX',
  'CLUSTER',
  'SHOW',
  'SET',
  'RESET',
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
  'DISCARD',
  'DEALLOCATE',
  'CLOSE',
  'FETCH',
  'MOVE',
  'LISTEN',
  'UNLISTEN',
  'CHECKPOINT',
]);

const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'MERGE']);
const READ_LEADS = new Set(['SELECT', 'VALUES', 'TABLE', 'WITH']);

function firstWord(tokens: Token[]): Token | undefined {
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === '(') continue;
    return t.type === 'word' ? t : undefined;
  }
  return undefined;
}

const hasWriteWord = (tokens: Token[]) => tokens.some((t) => t.type === 'word' && WRITE_WORDS.has(t.upper));

function statementGrows(tokens: Token[]): boolean {
  const lead = firstWord(tokens);
  if (!lead) return false;
  const word = lead.upper;
  if (READ_LEADS.has(word)) {
    const { kind } = classifyStatement(tokens);
    if (kind === 'select') return false;
    if (kind === 'dml' || kind === 'select_with_dml') return hasWriteWord(tokens);
    return true; // SELECT … INTO, unknown WITH shapes
  }
  if (word === 'EXPLAIN') {
    const analyze = tokens.some((t) => t.type === 'word' && (t.upper === 'ANALYZE' || t.upper === 'ANALYSE'));
    return analyze && hasWriteWord(tokens);
  }
  return !SHRINK_OR_READ.has(word);
}

export function sqlGrowsDatabase(query: unknown): boolean {
  if (typeof query !== 'string' || !query.trim()) return false;
  try {
    const tokens = tokenize(query);
    return splitStatements(query, tokens).some((s) => statementGrows(s.tokens));
  } catch {
    // A script the lexer cannot read is not ours to refuse here; the SQL route decides.
    return false;
  }
}
