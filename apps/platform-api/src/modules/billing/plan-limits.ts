/**
 * Plan facts that are not columns on the Plan row, plus the one byte
 * formatter every customer-facing limit message uses.
 */

/**
 * The largest page the Data grid may load from one table, per plan. It caps
 * how many rows one request returns — it is not a limit on how many rows a
 * table can store, and the REST API does not read it.
 */
export const DATA_GRID_ROW_LIMITS: Readonly<Record<string, number>> = {
  free: 1000,
  pro: 10000,
  business: 100000,
  enterprise: 100000,
};

/** The page-size ceiling for a plan; unknown plans get the Free ceiling. */
export function dataGridRowLimitFor(planName: string | null | undefined): number {
  return DATA_GRID_ROW_LIMITS[(planName || 'free').toLowerCase()] ?? DATA_GRID_ROW_LIMITS.free;
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/**
 * Bytes with binary (IEC) units — 1 GiB = 1024³ bytes — because every limit
 * and meter is computed in powers of 1024. Labelling those figures "GB" made
 * 1,073,741,824 bytes read as "1.0 GB" and 41,943,040 as "40 MB".
 */
export function formatBinaryBytes(input: bigint | number): string {
  const bytes = typeof input === 'bigint' ? Number(input) : input;
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  if (i < 0) i = 0;
  const value = bytes / 1024 ** i;
  const text = i === 0 ? String(Math.round(value)) : String(Number(value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)));
  return `${text} ${UNITS[i]}`;
}
