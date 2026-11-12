/**
 * Cron expressions for scheduled flows, as the dashboard reads them: the same
 * five-field syntax the API validates (apps/platform-api/src/modules/flows/flow-cron.ts),
 * plus a plain-English description and the next few run times for the editor's
 * preview. The API stays the authority — this only gives instant feedback.
 */

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
  fields: string[];
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Spec {
  label: string;
  min: number;
  max: number;
  names?: string[];
  base?: number;
}

const SPECS: Spec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTHS, base: 1 },
  { label: 'day of week', min: 0, max: 7, names: DAYS, base: 0 },
];

function num(token: string, s: Spec): number {
  const idx = s.names?.indexOf(token.toUpperCase()) ?? -1;
  if (idx >= 0) return idx + (s.base ?? 0);
  if (!/^\d+$/.test(token)) throw new Error(`"${token}" is not a valid ${s.label}`);
  const n = Number(token);
  if (n < s.min || n > s.max) throw new Error(`${s.label} ${n} is out of range (${s.min}-${s.max})`);
  return n;
}

function field(raw: string, s: Spec): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    if (!part) throw new Error(`the ${s.label} field has an empty list item`);
    if (/[?LW#]/i.test(part) && !(s.names && /^[A-Za-z]{3}(-[A-Za-z]{3})?(\/\d+)?$/.test(part))) {
      throw new Error(`"${part}" uses a Quartz extension (? L W #), which is not supported`);
    }
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`"${part}" has more than one step`);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) throw new Error(`step "${stepRaw}" must be a positive number`);
      step = Number(stepRaw);
    }
    let start: number;
    let end: number;
    if (range === '*') {
      start = s.min;
      end = s.max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || !a || !b) throw new Error(`"${range}" is not a valid ${s.label} range`);
      start = num(a, s);
      end = num(b, s);
      if (start > end) throw new Error(`range ${range} runs backwards`);
    } else {
      start = num(range, s);
      end = stepRaw !== undefined ? s.max : start;
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expression: string): ParsedCron {
  const source = (expression ?? '').trim().replace(/\s+/g, ' ');
  if (!source) throw new Error('Enter a cron expression');
  const expanded = MACROS[source.toLowerCase()] ?? source;
  if (expanded.startsWith('@')) throw new Error(`Unknown shorthand "${source}"`);
  const parts = expanded.split(' ');
  if (parts.length === 6) throw new Error('Seconds are not supported — use 5 fields: minute hour day month weekday');
  if (parts.length !== 5) throw new Error(`A cron needs 5 fields (minute hour day month weekday), got ${parts.length}`);
  const [mi, ho, dom, mo, dow] = parts.map((p, i) => field(p, SPECS[i]));
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    minutes: mi,
    hours: ho,
    daysOfMonth: dom,
    months: mo,
    daysOfWeek: dow,
    domRestricted: !parts[2].startsWith('*'),
    dowRestricted: !parts[4].startsWith('*'),
    fields: parts,
  };
}

export function cronError(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function wall(date: Date, tz: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAY[parts.weekday] ?? 0,
  };
}

function dayOk(c: ParsedCron, w: Wall): boolean {
  const d = c.daysOfMonth.has(w.day);
  const wd = c.daysOfWeek.has(w.weekday);
  return c.domRestricted && c.dowRestricted ? d || wd : d && wd;
}

/** The next `count` run times after `from`, read in time zone `tz`. */
export function nextRuns(expression: string, count = 3, tz = 'UTC', from = new Date()): Date[] {
  let c: ParsedCron;
  try {
    c = parseCron(expression);
  } catch {
    return [];
  }
  const out: Date[] = [];
  let t = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const horizon = t + 5 * 366 * 86_400_000;
  let guard = 0;
  while (out.length < count && t <= horizon && guard++ < 200_000) {
    const w = wall(new Date(t), tz);
    if (!c.months.has(w.month) || !dayOk(c, w)) {
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * 60_000;
      continue;
    }
    if (!c.hours.has(w.hour)) {
      t += (60 - w.minute) * 60_000;
      continue;
    }
    if (c.minutes.has(w.minute)) out.push(new Date(t));
    t += 60_000;
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

function listWords(values: number[], labels: string[], offset = 0): string {
  const words = values.map((v) => labels[v - offset]);
  if (words.length <= 2) return words.join(' and ');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function stepOf(raw: string): number | null {
  const m = raw.match(/^\*\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** A plain-English reading such as "Every 15 minutes" or "At 09:30, Monday through Friday". */
export function describeCron(expression: string): string {
  let c: ParsedCron;
  try {
    c = parseCron(expression);
  } catch {
    return '';
  }
  const [mRaw, hRaw, domRaw, moRaw, dowRaw] = c.fields;
  const minutes = [...c.minutes].sort((a, b) => a - b);
  const hours = [...c.hours].sort((a, b) => a - b);

  let time: string;
  if (mRaw === '*' && hRaw === '*') time = 'Every minute';
  else if (stepOf(mRaw) && hRaw === '*') time = `Every ${stepOf(mRaw)} minutes`;
  else if (minutes.length === 1 && hRaw === '*') time = `Every hour at minute ${minutes[0]}`;
  else if (minutes.length === 1 && stepOf(hRaw)) time = `Every ${stepOf(hRaw)} hours at minute ${minutes[0]}`;
  else if (minutes.length === 1 && hours.length <= 6) time = `At ${hours.map((h) => `${pad(h)}:${pad(minutes[0])}`).join(', ')}`;
  else if (mRaw === '*' && hours.length <= 6) time = `Every minute during hour ${hours.join(', ')}`;
  else if (stepOf(mRaw)) time = `Every ${stepOf(mRaw)} minutes during hours ${hRaw}`;
  else time = `At minute ${mRaw} past hour ${hRaw}`;

  const parts: string[] = [time];
  const days = [...c.daysOfWeek].sort((a, b) => a - b);
  const doms = [...c.daysOfMonth].sort((a, b) => a - b);
  const dayText = (() => {
    if (dowRaw === '*') return '';
    if (days.length === 5 && days.join() === '1,2,3,4,5') return 'Monday through Friday';
    if (days.length === 2 && days.join() === '0,6') return 'on weekends';
    return `on ${listWords(days, DAY_LABELS)}`;
  })();
  const domText = domRaw === '*' ? '' : doms.length <= 5 ? `on day ${doms.join(', ')} of the month` : `on days ${domRaw} of the month`;
  if (domText && dayText) parts.push(`${domText} or ${dayText}`);
  else if (domText) parts.push(domText);
  else if (dayText) parts.push(dayText);
  if (moRaw !== '*') {
    const months = [...c.months].sort((a, b) => a - b);
    parts.push(months.length <= 4 ? `in ${listWords(months, MONTH_LABELS, 1)}` : `in months ${moRaw}`);
  }
  return parts.join(', ');
}

/** Shortcuts offered in the editor. */
export const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday at 08:00', cron: '0 8 * * 1' },
  { label: 'First day of the month', cron: '0 0 1 * *' },
];
