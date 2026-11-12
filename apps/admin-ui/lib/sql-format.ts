/**
 * A small SQL formatter for the SQL editor's "Format" button.
 *
 * It re-flows whitespace only: keywords are upper-cased, each clause starts on
 * its own line, select lists and AND/OR conditions go one per line, and
 * subqueries are indented. Strings, quoted identifiers, comments and
 * dollar-quoted bodies are copied through untouched, so formatting never
 * changes what a statement does.
 */

type Tok =
  | { kind: 'word'; text: string }
  | { kind: 'raw'; text: string } // strings, quoted identifiers, numbers, operators
  | { kind: 'comment'; text: string; line: boolean }
  | { kind: 'punct'; text: string };

const KEYWORDS = new Set(
  (
    'select from where group by order having limit offset fetch first next rows only union all intersect except ' +
    'values insert into update set delete returning with recursive as on using join left right full inner outer cross natural ' +
    'and or not in is null true false like ilike between exists case when then else end distinct asc desc nulls last ' +
    'create table view index unique primary key references foreign constraint default check alter add drop column rename to ' +
    'if cascade restrict begin commit rollback grant revoke truncate conflict do nothing lateral window over partition filter ' +
    'materialized function returns language replace trigger for each row execute procedure schema sequence type enum cast any some'
  ).split(/\s+/),
);

/** Clauses that start a new line. Multi-word ones are matched on their first word. */
const CLAUSE_STARTERS: Array<string[]> = [
  ['SELECT'], ['FROM'], ['WHERE'], ['GROUP', 'BY'], ['ORDER', 'BY'], ['HAVING'], ['LIMIT'], ['OFFSET'],
  ['FETCH'], ['UNION'], ['INTERSECT'], ['EXCEPT'], ['VALUES'], ['SET'], ['RETURNING'], ['ON', 'CONFLICT'],
  ['WINDOW'], ['INSERT'], ['UPDATE'], ['DELETE'], ['WITH'],
  ['LEFT'], ['RIGHT'], ['FULL'], ['INNER'], ['CROSS'], ['JOIN'], ['NATURAL'],
];

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      out.push({ kind: 'comment', text: sql.slice(i, end), line: true });
      i = end;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
        else if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
        else j++;
      }
      out.push({ kind: 'comment', text: sql.slice(i, j), line: false });
      i = j;
      continue;
    }
    if (c === "'" || ((c === 'E' || c === 'e') && sql[i + 1] === "'")) {
      const backslash = c !== "'";
      let j = i + (backslash ? 2 : 1);
      while (j < n) {
        if (backslash && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out.push({ kind: 'raw', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          j++;
          break;
        }
        j++;
      }
      out.push({ kind: 'raw', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        const end = close === -1 ? n : close + m[0].length;
        out.push({ kind: 'raw', text: sql.slice(i, end) });
        i = end;
        continue;
      }
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      out.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if ('(),;'.includes(c)) {
      out.push({ kind: 'punct', text: c });
      i++;
      continue;
    }
    // numbers, operators, dots, casts: one run of non-space, non-special characters
    let j = i + 1;
    while (j < n && !/[\s(),;'"$]/.test(sql[j]) && !/[A-Za-z_]/.test(sql[j]) && !(sql[j] === '-' && sql[j + 1] === '-')) j++;
    if (/[0-9]/.test(c)) {
      while (j < n && /[0-9A-Za-z_.]/.test(sql[j])) j++;
    }
    out.push({ kind: 'raw', text: sql.slice(i, j) });
    i = j;
  }
  return out;
}

const upper = (t: Tok | undefined) => (t && t.kind === 'word' ? t.text.toUpperCase() : '');

export function formatSql(sql: string): string {
  const toks = tokenize(sql);
  const lines: string[] = [];
  let line = '';
  /** Open parentheses; true = a subquery (indent), false = a call or list. */
  const parens: boolean[] = [];
  const indentLevel = () => parens.filter(Boolean).length;
  const pad = (extra = 0) => '  '.repeat(indentLevel() + extra);
  /** The clause we are in at the current subquery level (for commas). */
  let clause = '';

  const newline = (extra = 0) => {
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    line = pad(extra);
  };
  const append = (text: string, space = true) => {
    if (!line.trim()) line += text;
    else if (!space || /[(.]$/.test(line) || text === ')' || text === ',' || text.startsWith('::') || text === '.') line += text;
    else line += ` ${text}`;
  };

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    const prev = toks[k - 1];

    if (t.kind === 'comment') {
      append(t.text);
      if (t.line) newline();
      continue;
    }

    if (t.kind === 'punct') {
      if (t.text === ';') {
        line = line.replace(/\s+$/, '') + ';';
        parens.length = 0;
        clause = '';
        lines.push(line);
        lines.push('');
        line = '';
        continue;
      }
      if (t.text === '(') {
        const next = upper(toks[k + 1]);
        const sub = next === 'SELECT' || next === 'WITH' || next === 'VALUES';
        append('(', !(prev && prev.kind === 'word' && !KEYWORDS.has(prev.text.toLowerCase())) && prev?.text !== '(');
        parens.push(sub);
        if (sub) {
          clause = '';
          newline();
        }
        continue;
      }
      if (t.text === ')') {
        const wasSub = parens.pop();
        if (wasSub) newline();
        line = line.trim() ? line + ')' : line + ')';
        if (wasSub) clause = '';
        continue;
      }
      if (t.text === ',') {
        line += ',';
        const atClauseLevel = parens.length === 0 || parens[parens.length - 1];
        if (atClauseLevel && ['SELECT', 'GROUP', 'ORDER', 'SET', 'RETURNING', 'VALUES', 'WITH'].includes(clause)) {
          newline(clause === 'WITH' ? 0 : 1);
        }
        continue;
      }
    }

    if (t.kind === 'word') {
      const u = t.text.toUpperCase();
      const isKw = KEYWORDS.has(t.text.toLowerCase());
      const text = isKw ? u : t.text;
      const atClauseLevel = parens.length === 0 || parens[parens.length - 1];

      const starter = CLAUSE_STARTERS.find((s) => s[0] === u && s.every((w, i) => upper(toks[k + i]) === w));
      // JOIN modifiers (LEFT/RIGHT/…) count only when a JOIN follows; ON CONFLICT
      // only as ON CONFLICT; UPDATE inside ON CONFLICT DO UPDATE stays inline.
      const joinish = ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL'].includes(u);
      const joinFollows = joinish && toks.slice(k + 1, k + 4).some((x) => upper(x) === 'JOIN');
      const afterJoinMod = u === 'JOIN' && ['LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'NATURAL', 'OUTER'].includes(upper(prev));
      const inlineUpdate = u === 'UPDATE' && upper(prev) === 'DO';
      const insertSelect = u === 'SELECT' && upper(prev) === 'UNION';

      if (
        atClauseLevel &&
        starter &&
        (!joinish || joinFollows) &&
        !afterJoinMod &&
        !inlineUpdate &&
        !(u === 'SET' && upper(prev) !== 'UPDATE' && clause !== 'UPDATE' && clause !== 'DO') &&
        !insertSelect &&
        !(u === 'FROM' && clause === 'DELETE')
      ) {
        if (line.trim()) newline();
        clause = u === 'GROUP' || u === 'ORDER' ? u : u === 'ON' ? 'ON' : u;
        append(text);
        continue;
      }
      if (atClauseLevel && (u === 'AND' || u === 'OR') && ['WHERE', 'HAVING', 'ON'].includes(clause)) {
        newline(1);
        append(text);
        continue;
      }
      if (u === 'DO' && clause === 'ON') clause = 'DO';
      append(text, !(prev && prev.kind === 'raw' && /[.:]$/.test(prev.text)));
      continue;
    }

    // raw: strings, quoted identifiers, numbers, operators
    const glue = t.text === '.' || t.text.startsWith('::') || t.text.startsWith('.') || (prev && prev.kind === 'raw' && prev.text === '.');
    append(t.text, !glue);
  }
  if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
