import type { ApplyResult, StatementResult } from './ai-database.service';

/**
 * The outcome of an approved change, in words, built from what Postgres
 * returned and what the catalog holds afterwards — never from the model. This
 * text is what the person reads under the change and what the assistant sees
 * in the next turn, so "RLS was enabled" can only appear when it was.
 */
export function describeOutcome(result: ApplyResult): string {
  const lines: string[] = [];
  const total = result.statements.length;
  const failed = result.failedIndex !== null ? result.statements[result.failedIndex] : null;

  if (failed) {
    const n = (result.failedIndex as number) + 1;
    if (result.atomic) {
      lines.push(
        `**Nothing was changed.** Statement ${n} failed, so the whole change was rolled back.`,
        `Error: ${failed.error}`,
      );
    } else {
      const applied = result.failedIndex as number;
      lines.push(
        applied
          ? `**Partly applied.** Statements 1–${applied} ran and were kept; statement ${n} failed and the rest did not run.`
          : `**Nothing was changed.** Statement ${n} failed.`,
        `Error: ${failed.error}`,
      );
    }
  } else {
    lines.push(`**Applied ${total} statement${total === 1 ? '' : 's'}.**`);
  }

  const checks: string[] = [];
  result.statements.forEach((s, i) => {
    if (!s.ok) return;
    if (result.failedIndex !== null && result.atomic) return;
    const rows = rowLine(s);
    if (rows) checks.push(`${s.verification.length ? '' : '✓ '}Statement ${i + 1}: ${rows}`.trim());
    for (const v of s.verification) checks.push(`${v.passed ? '✓' : '✗'} ${v.label}`);
  });
  if (checks.length) {
    lines.push('', 'Checked in the database after the change:', ...checks.map((c) => `- ${c}`));
  }
  const problems = result.statements.flatMap((s) => s.verification.filter((v) => !v.passed));
  if (!failed && problems.length) {
    lines.push('', `**Warning:** the statements ran, but ${problems.length} check${problems.length === 1 ? '' : 's'} did not match the intended result.`);
  }
  return lines.join('\n');
}

function rowLine(s: StatementResult): string | null {
  const cmd = s.command.toUpperCase();
  const n = s.rowCount ?? 0;
  const plural = (word: string) => `${n} row${n === 1 ? '' : 's'} ${word}`;
  if (cmd === 'INSERT') return plural('inserted');
  if (cmd === 'UPDATE') return plural('updated');
  if (cmd === 'DELETE') return plural('deleted');
  if (cmd === 'MERGE') return plural('merged');
  if (cmd === 'SELECT') return `${s.rows.length} row${s.rows.length === 1 ? '' : 's'} returned`;
  return null;
}
