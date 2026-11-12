/**
 * Date and number formatting for the dashboard.
 *
 * The dashboard is written in English, so every date and number is formatted
 * with one fixed English locale instead of the browser's language. Calling
 * `toLocaleString()` without a locale printed "21 Eki 2026" or "50.000" for a
 * browser set to Turkish next to "Oct 21, 2026" and "30,590" elsewhere.
 *
 * Times are shown in the viewer's own time zone, and date-times say which zone
 * that is ("Oct 21, 2026, 11:21 PM GMT+3"), so they can be compared with UTC
 * values such as backup schedules or export file names.
 */

export const UI_LOCALE = 'en-US';

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 21, 2026" — or `fallback` for a missing / invalid value. */
export function formatDate(value: DateInput, fallback = '—'): string {
  const d = toDate(value);
  if (!d) return fallback;
  return d.toLocaleDateString(UI_LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * "Oct 21, 2026, 11:21 PM GMT+3". Pass `seconds` for log-style precision and
 * `timeZoneName: false` where the zone is already stated nearby.
 */
export function formatDateTime(
  value: DateInput,
  opts: { seconds?: boolean; timeZoneName?: boolean; fallback?: string } = {},
): string {
  const d = toDate(value);
  if (!d) return opts.fallback ?? '—';
  return d.toLocaleString(UI_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(opts.seconds ? { second: '2-digit' } : {}),
    ...(opts.timeZoneName === false ? {} : { timeZoneName: 'short' }),
  });
}

/** "11:21 PM" in the viewer's zone. */
export function formatTime(value: DateInput, fallback = '—'): string {
  const d = toDate(value);
  if (!d) return fallback;
  return d.toLocaleTimeString(UI_LOCALE, { hour: 'numeric', minute: '2-digit' });
}

/** "1,234,567" — English grouping regardless of the browser language. */
export function formatNumber(
  value: number | null | undefined,
  opts: Intl.NumberFormatOptions = {},
  fallback = '0',
): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return fallback;
  return Number(value).toLocaleString(UI_LOCALE, opts);
}
