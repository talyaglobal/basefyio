/**
 * The viewer's time zone as a short label, e.g. "Europe/Istanbul, UTC+3".
 *
 * Log screens print timestamps with toLocaleString(), i.e. in the viewer's
 * local time, without saying so; this label says which zone that is.
 */
export function localZoneLabel(date: Date = new Date()): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const offset = `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
  let name = '';
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    name = '';
  }
  return name ? `${name}, ${offset}` : offset;
}
