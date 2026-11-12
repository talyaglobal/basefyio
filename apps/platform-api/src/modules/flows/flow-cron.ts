/**
 * Cron expressions for scheduled flows.
 *
 * The standard five fields — minute, hour, day of month, month, day of week —
 * with `*`, single values, ranges (`1-5`), steps (`*\/15`, `0-30/10`, `5/15`),
 * lists (`1,15,30`), month and weekday names (`JAN`, `MON-FRI`), `7` as Sunday
 * and the `@hourly` / `@daily` / `@weekly` / `@monthly` / `@yearly` shorthands.
 *
 * Deliberately not supported, and refused with a message saying so: a sixth
 * (seconds) field, Quartz extensions (`?`, `L`, `W`, `#`). A schedule fires at
 * most once a minute.
 *
 * Day of month and day of week follow the classic rule: when both are
 * restricted (neither starts with `*`) a day matches if EITHER matches;
 * otherwise both must.
 *
 * Kept dependency-free on purpose: the scheduler, the API validation and the
 * "next run" preview all share this one reading of an expression.
 */

export class CronParseError extends Error {}

export interface ParsedCron {
  source: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday (7 is folded into 0). */
  daysOfWeek: ReadonlySet<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
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

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: string[];
  /** first name maps to this number */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { label: 'day of week', min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

function parseNumber(token: string, spec: FieldSpec): number {
  const upper = token.toUpperCase();
  if (spec.names) {
    const idx = spec.names.indexOf(upper);
    if (idx >= 0) return idx + (spec.nameBase ?? 0);
  }
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(`"${token}" is not a valid ${spec.label}`);
  }
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new CronParseError(`${spec.label} ${n} is out of range (${spec.min}-${spec.max})`);
  }
  return n;
}

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  if (raw === '') throw new CronParseError(`the ${spec.label} field is empty`);
  for (const part of raw.split(',')) {
    if (part === '') throw new CronParseError(`the ${spec.label} field has an empty list item`);
    if (/[?LW#]/i.test(part) && !(spec.names && /^[A-Za-z]{3}(-[A-Za-z]{3})?(\/\d+)?$/.test(part))) {
      throw new CronParseError(
        `"${part}" uses a Quartz extension (? L W #), which is not supported — use plain 5-field cron`,
      );
    }
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new CronParseError(`"${part}" has more than one step`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new CronParseError(`step "${stepPart}" in the ${spec.label} field must be a positive number`);
      }
      step = Number(stepPart);
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined || a === '' || b === '') {
        throw new CronParseError(`"${rangePart}" is not a valid ${spec.label} range`);
      }
      start = parseNumber(a, spec);
      end = parseNumber(b, spec);
      if (start > end) {
        throw new CronParseError(`range ${rangePart} in the ${spec.label} field runs backwards`);
      }
    } else {
      start = parseNumber(rangePart, spec);
      // "5/15" means from 5 to the end of the field, every 15.
      end = stepPart !== undefined ? spec.max : start;
    }
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

/** Parse an expression; throws CronParseError with a human message. */
export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new CronParseError('cron expression is empty');
  }
  const source = expression.trim().replace(/\s+/g, ' ');
  const expanded = MACROS[source.toLowerCase()] ?? source;
  if (expanded.startsWith('@')) {
    throw new CronParseError(`unknown shorthand "${source}"`);
  }
  const parts = expanded.split(' ');
  if (parts.length === 6) {
    throw new CronParseError(
      'cron has 6 fields; seconds are not supported — use 5 fields: minute hour day-of-month month day-of-week',
    );
  }
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron needs 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    );
  }
  const [mi, ho, dom, mo, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    source,
    minutes: mi,
    hours: ho,
    daysOfMonth: dom,
    months: mo,
    daysOfWeek: dow,
    domRestricted: !parts[2].startsWith('*'),
    dowRestricted: !parts[4].startsWith('*'),
  };
}

/** null when valid, otherwise the reason. */
export function cronError(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The calendar fields of an instant as read on a wall clock in `timeZone`. */
export function wallClock(date: Date, timeZone = 'UTC'): WallClock {
  if (timeZone === 'UTC') {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      weekday: date.getUTCDay(),
    };
  }
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    formatterCache.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

function dayMatches(cron: ParsedCron, w: WallClock): boolean {
  const dom = cron.daysOfMonth.has(w.day);
  const dow = cron.daysOfWeek.has(w.weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
}

/** True when the minute containing `date` is a tick of `cron`. */
export function cronMatches(cron: ParsedCron, date: Date, timeZone = 'UTC'): boolean {
  const w = wallClock(date, timeZone);
  return (
    cron.months.has(w.month) &&
    dayMatches(cron, w) &&
    cron.hours.has(w.hour) &&
    cron.minutes.has(w.minute)
  );
}

/** Truncate to the start of the minute. */
export function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

/**
 * The next `count` ticks strictly after `from`. Walks forward skipping whole
 * days and hours that cannot match, so even "Feb 29 only" resolves quickly.
 * Gives up after ~5 years of calendar (an expression like "31 2 *" never fires).
 */
export function nextCronTimes(cron: ParsedCron, from: Date, count = 1, timeZone = 'UTC'): Date[] {
  const out: Date[] = [];
  let t = floorToMinute(from).getTime() + 60_000;
  const horizon = t + 5 * 366 * 24 * 60 * 60_000;
  let guard = 0;
  while (out.length < count && t <= horizon && guard++ < 500_000) {
    const w = wallClock(new Date(t), timeZone);
    if (!cron.months.has(w.month) || !dayMatches(cron, w)) {
      // Jump to the next local midnight.
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * 60_000;
      continue;
    }
    if (!cron.hours.has(w.hour)) {
      t += (60 - w.minute) * 60_000;
      continue;
    }
    if (cron.minutes.has(w.minute)) out.push(new Date(t));
    t += 60_000;
  }
  return out;
}
