/**
 * How a database value is shown, edited and exported in the dashboard grids
 * (data editor, SQL results).
 *
 * The API returns json/jsonb and array columns as JSON objects and arrays.
 * `String(value)` turned every one of them into "[object Object]" — in the
 * grid, in SQL results, and worst, in the cell editor, where saving would
 * have overwritten the real document with that text. Everything that renders
 * or edits a cell goes through these helpers instead.
 */

/** True for values that come back as JSON structures (json/jsonb/arrays). */
export function isStructured(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/** One-line text for a grid cell. `null`/`undefined` are left to the caller (NULL badge). */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (isStructured(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Multi-line text for a tooltip: structured values pretty-printed. */
export function formatCellTitle(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (isStructured(value)) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Text placed in an editor for this value; '' for NULL. */
export function cellToEditText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return formatCellValue(value);
}

/** A value for a spreadsheet / CSV / Markdown cell. */
export function exportCellValue(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return formatCellValue(value);
}

/** CSV field with RFC 4180 quoting. */
export function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : formatCellValue(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
