/**
 * Making a schema dump from the source database safe to apply here, and safe to
 * apply again.
 *
 * Two things went wrong with a dump taken by a newer pg_dump and replayed into
 * this cluster (Postgres 16):
 *  - it carries psql meta-commands (`\restrict`, `\unrestrict`) that are not SQL,
 *    and settings an older server does not know (`SET transaction_timeout`); and
 *  - on a re-import every object already exists, so "schema public already
 *    exists" and "function X already exists with same argument types" were
 *    counted as 275 failures although nothing was wrong.
 *
 * Everything here is a pure function so the rules can be tested without a
 * database.
 */

/**
 * Settings a dump may set that older servers reject. A dump from Postgres 17
 * opens with `SET transaction_timeout = 0;`, an unrecognised parameter on 16.
 */
const UNKNOWN_SETTINGS = ['transaction_timeout'];

/**
 * Remove what is not SQL for this server: psql meta-commands (any line whose
 * first character is a backslash, such as `\restrict <token>` and `\unrestrict`)
 * and `SET` of a parameter an older server does not have.
 */
export function sanitizeSchemaDump(sql: string): string {
  const unknown = new RegExp(`^\\s*SET\\s+(?:SESSION\\s+|LOCAL\\s+)?(?:${UNKNOWN_SETTINGS.join('|')})\\b`, 'i');
  return sql
    .split('\n')
    .filter((line) => !line.startsWith('\\') && !unknown.test(line))
    .join('\n');
}

/** An identifier, quoted or not: `tbl`, `"My Tbl"`. */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
/** An optionally schema-qualified name: `public.tbl`, `"public"."tbl"`. */
const QUALIFIED = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`;

/**
 * The statements to run for one dumped statement, so that running them on a
 * database that already has the object leaves it as the source defines it:
 * functions and views are replaced, tables, indexes, sequences and schemas are
 * created only when missing, and a policy or trigger is dropped first.
 *
 * A statement this does not recognise is returned unchanged; whether it
 * collides is then decided by {@link isAlreadyPresentError}.
 */
export function makeIdempotent(statement: string): string[] {
  let s = statement;

  // Replaceable objects.
  s = s.replace(/^(\s*CREATE)\s+(FUNCTION|PROCEDURE)\b/i, (m, head, kind) =>
    /\bOR\s+REPLACE\b/i.test(m) ? m : `${head} OR REPLACE ${kind}`,
  );
  s = s.replace(/^(\s*CREATE)\s+(?!OR\s+REPLACE\b)(VIEW)\b/i, '$1 OR REPLACE $2');

  // Objects that cannot be replaced: create only when missing.
  s = s.replace(/^(\s*CREATE\s+SCHEMA)\s+(?!IF\s+NOT\s+EXISTS\b)/i, '$1 IF NOT EXISTS ');
  s = s.replace(/^(\s*CREATE\s+(?:UNLOGGED\s+)?TABLE)\s+(?!IF\s+NOT\s+EXISTS\b)/i, '$1 IF NOT EXISTS ');
  s = s.replace(/^(\s*CREATE\s+SEQUENCE)\s+(?!IF\s+NOT\s+EXISTS\b)/i, '$1 IF NOT EXISTS ');
  s = s.replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX)\s+(?!IF\s+NOT\s+EXISTS\b|CONCURRENTLY\b)/i, '$1 IF NOT EXISTS ');

  // Objects with no IF NOT EXISTS form: drop, then create.
  const policy = new RegExp(`^\\s*CREATE\\s+POLICY\\s+(${IDENT})\\s+ON\\s+(${QUALIFIED})`, 'i').exec(s);
  if (policy) return [`DROP POLICY IF EXISTS ${policy[1]} ON ${policy[2]}`, s];

  const trigger = new RegExp(
    `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:CONSTRAINT\\s+)?TRIGGER\\s+(${IDENT})[\\s\\S]*?\\bON\\s+(${QUALIFIED})`,
    'i',
  ).exec(s);
  if (trigger) return [`DROP TRIGGER IF EXISTS ${trigger[1]} ON ${trigger[2]}`, s];

  return [s];
}

/**
 * SQLSTATEs that mean "this object is already here": a duplicate schema, table,
 * column, object (constraint, type, trigger…) or function, and a second primary
 * key. On a re-import these are the expected outcome for everything that did not
 * change, so they are not failures.
 */
const ALREADY_PRESENT_CODES = new Set(['42P06', '42P07', '42701', '42710', '42723', '42P16']);

export function isAlreadyPresentError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code && ALREADY_PRESENT_CODES.has(err.code)) return true;
  // "column … is already an identity column" has no dedicated SQLSTATE.
  return /already (?:exists|an identity column)/i.test(err.message ?? '') && err.code !== '42P01';
}

/**
 * Run the statements of one dumped object as a unit.
 *
 * A policy or trigger is replaced by dropping it and creating it again. Done as
 * two separate statements, a CREATE that fails (a policy written against the
 * source's `auth.uid()` that returns uuid, compared here with text) leaves the
 * object dropped, and the table keeps row level security with fewer policies
 * than it had. Inside a transaction the failed CREATE rolls the DROP back, so an
 * existing object is only ever replaced by one that was created.
 */
export async function runStatementGroup(
  client: { query: (sql: string) => Promise<unknown> },
  statements: string[],
): Promise<void> {
  if (statements.length <= 1) {
    for (const s of statements) await client.query(s);
    return;
  }
  await client.query('BEGIN');
  try {
    for (const s of statements) await client.query(s);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/**
 * A foreign key into `auth.users`. Users of the project live in its identity
 * service, not in a table, so such a key can never be satisfied for a user
 * created after the import: new sign-ups failed with "Key (user_id) is not
 * present in table users". These are left out and reported instead.
 */
export function referencesAuthUsers(statement: string): boolean {
  return /^\s*ALTER\s+TABLE[\s\S]*?\bFOREIGN\s+KEY[\s\S]*?\bREFERENCES\s+"?auth"?\s*\.\s*"?users"?\b/i.test(statement);
}
