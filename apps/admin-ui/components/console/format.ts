export { formatUsd } from '@/components/project-costs-panel';

/*
 * One set of formatters for the whole root console. Every screen used to
 * format on its own — "21.10.2026" next to "21 Oct 2026", "1.699.939" next to
 * "1,017,502", "9,161 MB" next to "8.95 GB" — depending on the browser's
 * language. These are fixed to one style regardless of locale.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Binary units, as storage tools report them: 1 MB = 1024 KB. Always about three significant digits. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${UNITS[i]}`;
}

/** @deprecated Use formatBytes — one unit style everywhere. Kept for older imports. */
export function formatMb(bytes: number | null | undefined): string {
  return formatBytes(bytes);
}

/** Compact counts: 1,234 · 12K · 1.7M. */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`;
  return n.toLocaleString('en-US');
}

/** Exact numbers with thousands separators: 1,699,939. */
export function formatNumber(n: number | null | undefined, maxFractionDigits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits });
}

/** Whole hours with a separator: "65,731 h". */
export function formatHours(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '—';
  return `${Math.round(hours).toLocaleString('en-US')} h`;
}

function toDate(iso: string | number | Date | null | undefined): Date | null {
  if (iso == null || iso === '') return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** "21 Oct 2026", in the viewer's time zone. */
export function formatDate(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "21 Oct 2026, 14:05", in the viewer's time zone. */
export function formatDateTime(iso: string | number | Date | null | undefined): string {
  const d = toDate(iso);
  if (!d) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)}, ${hh}:${mm}`;
}

/**
 * A calendar day given as "2026-09-24" or "20260924" (Search Console, GA4),
 * shown as "24 Sep". Read as a date, never shifted by the time zone.
 */
export function formatDayLabel(day: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(day || '');
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** "Oct 2026" — the full year, so it never reads as a day of the month. */
export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.slice(0, 7).split('-').map(Number);
  return `${MONTHS[m - 1] ?? ''} ${y}`;
}

/** "ACCOUNT_ROLE_UPDATED" → "Account role updated". Leaves ordinary text alone. */
export function humanizeCode(code: string | null | undefined): string {
  if (!code) return '';
  if (!/^[A-Z0-9]+(?:[_.][A-Z0-9]+)+$/i.test(code) || /\s/.test(code)) return code;
  const words = code.replace(/[_.]+/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A UUID shortened for display ("2abaadce…"); the full value belongs in a title/tooltip. */
export function shortId(id: string | null | undefined): string {
  if (!id) return '';
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
