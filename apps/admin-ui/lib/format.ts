// One locale for every date and number the UI prints, whatever the browser language is.
// The interface is English, so dates read "Oct 21, 2026" and numbers "1,000".
const UI_LOCALE = 'en-US';

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateFmt = new Intl.DateTimeFormat(UI_LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });
// Times always carry the viewer's time zone ("GMT+3"), so a stored UTC instant is never read as local.
const dateTimeFmt = new Intl.DateTimeFormat(UI_LOCALE, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** "Oct 21, 2026"; "—" for a missing or invalid date. */
export function formatDate(value: DateInput): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : '—';
}

/** "Oct 21, 2026, 11:21 PM GMT+3"; "—" for a missing or invalid date. */
export function formatDateTime(value: DateInput): string {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : '—';
}

/** Digits grouped with commas ("1,000"). */
export function formatNumber(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString(UI_LOCALE);
}

/** "AUTH_ROLE_UPDATED_TO_ROOT" -> "Auth role updated to root"; anything else is returned unchanged. */
export function humanizeCode(code: string | null | undefined): string {
  if (!code) return '—';
  if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(code)) return code;
  const words = code.toLowerCase().split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Alert text as stored holds codes and ids ("AUTH_USER_DEACTIVATED … (uuid) on team:uuid"); show words only. */
export function humanizeMessage(text: string | null | undefined): string {
  if (!text) return '';
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  return text
    .replace(new RegExp(`\s*\(${uuid}\)`, 'gi'), '')
    .replace(new RegExp(`\b(\w+):\s*${uuid}`, 'gi'), '$1')
    .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, (m) => humanizeCode(m).toLowerCase());
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Binary units (1 MB = 1024 KB) that step up on their own, so one size reads the same on every screen: "8.95 GB", "2.42 KB", "0 B". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toLocaleString(UI_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${BYTE_UNITS[i]}`;
}
