/**
 * AI Agent mode safety helpers (feedback #157, #158). Pure functions, no imports.
 *
 * Agent mode runs a statement on its own only when it is a read, and then over the
 * server's read-only path (a READ ONLY transaction that is rolled back), so a
 * misclassified statement still cannot change anything. Everything else waits for
 * the user's approval.
 */

export type AgentStepStatus = 'ran' | 'failed' | 'pending' | 'skipped' | 'cancelled';

export interface AgentStepLike {
  sql: string;
  status?: AgentStepStatus;
  /** Legacy steps (before statuses) carry only `error`. */
  error?: string;
}

/** The SQL with comments and quoted text blanked out, so keywords inside them are not read. */
function stripCommentsAndLiterals(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

const READ_START = /^(SELECT|WITH|VALUES|TABLE|EXPLAIN)\b/i;
const WRITE_WORD =
  /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|REINDEX|CLUSTER|REFRESH|COMMENT|SECURITY|ANALYZE|INTO)\b/i;

/**
 * True for one read statement (SELECT, WITH, VALUES, TABLE, EXPLAIN) that names no
 * write. Errs towards "not a read": a false "not a read" only asks for approval.
 */
export function isReadStatement(sql: string): boolean {
  const body = stripCommentsAndLiterals(sql).trim().replace(/;\s*$/, '');
  if (!body || body.includes(';')) return false;
  if (!READ_START.test(body)) return false;
  return !WRITE_WORD.test(body);
}

/**
 * A policy that lets anyone write: `USING (true)` / `WITH CHECK (true)` on
 * INSERT, UPDATE, DELETE or ALL. Shown as a warning before the user approves.
 */
export function grantsPublicWrite(sql: string): boolean {
  const body = stripCommentsAndLiterals(sql).replace(/\s+/g, ' ');
  if (!/\bCREATE POLICY\b|\bALTER POLICY\b/i.test(body)) return false;
  const forClause = /\bFOR (ALL|INSERT|UPDATE|DELETE)\b/i.exec(body);
  const isSelectOnly = /\bFOR SELECT\b/i.test(body);
  // A policy with no FOR clause applies to ALL commands.
  if (isSelectOnly && !forClause) return false;
  return /\b(USING|WITH CHECK) \( ?true ?\)/i.test(body);
}

/** Counts by outcome, for a status line that does not depend on the model's wording. */
export function stepCounts(steps: AgentStepLike[]): Record<AgentStepStatus, number> {
  const out: Record<AgentStepStatus, number> = { ran: 0, failed: 0, pending: 0, skipped: 0, cancelled: 0 };
  for (const s of steps) out[s.status ?? (s.error ? 'failed' : 'ran')]++;
  return out;
}

/**
 * The facts the summarizing model must not contradict, as plain sentences. Placed
 * before the results it reads, and shown to the user beside the model's answer.
 */
export function outcomeSentence(steps: AgentStepLike[]): string {
  const c = stepCounts(steps);
  const parts: string[] = [];
  if (c.ran) parts.push(`${c.ran} succeeded`);
  if (c.failed) parts.push(`${c.failed} failed and changed nothing`);
  if (c.skipped) parts.push(`${c.skipped} not run because an earlier statement failed`);
  if (c.cancelled) parts.push(`${c.cancelled} cancelled by the user`);
  if (c.pending) parts.push(`${c.pending} waiting for approval`);
  const total = steps.length;
  return `${total} ${total === 1 ? 'statement' : 'statements'}: ${parts.join(', ') || 'none run'}.`;
}
