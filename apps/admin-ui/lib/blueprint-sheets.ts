import * as XLSX from 'xlsx';
import type { BlueprintSheet } from './types';

/**
 * Reading spreadsheets for the App Builder.
 *
 * CSV bytes are decoded here rather than by SheetJS, which reads a CSV
 * without a byte-order mark as Latin-1 ("Müşteri" → "MÃ¼Återi"). The order:
 * a BOM decides; strictly valid UTF-8 stays UTF-8; anything else is read as
 * Windows-1254, the code page Turkish Excel saves CSV in. Cells are kept as
 * the exact text of the file — SheetJS would otherwise read "12,50" as 1250
 * and "01.02.2026" as a month-first date — and the server, which knows the
 * file's number and date format, converts them.
 *
 * Workbook date cells become "YYYY-MM-DD" (or "YYYY-MM-DD HH:MM:SS") from
 * their serial number, with no time-zone shift.
 */

/** Rows per sheet sent to the server; the request body is capped at 10 MB. */
export const MAX_ROWS_PER_SHEET = 50_000;
const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024;

export interface ParsedFile {
  sheets: BlueprintSheet[];
  /** CSV only: how the bytes were decoded. */
  encoding?: string;
  /** True when some rows were left out to fit the request size. */
  truncated: boolean;
}

const TEXT_EXT = /\.(csv|tsv|txt)$/i;

export function isTextSpreadsheet(fileName: string): boolean {
  return TEXT_EXT.test(fileName);
}

/** The file name without its extension, used as the CSV's table name. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.(xlsx|xlsm|xls|csv|tsv|txt)$/i, '') || 'Sheet1';
}

export function decodeTextBytes(buf: ArrayBuffer): { text: string; encoding: string } {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16' };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    // not UTF-8
  }
  try {
    return { text: new TextDecoder('windows-1254').decode(bytes), encoding: 'Windows-1254 (Turkish)' };
  } catch {
    return { text: new TextDecoder('iso-8859-1').decode(bytes), encoding: 'ISO-8859-1' };
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

function excelDate(serial: number, date1904: boolean): string | null {
  const p = XLSX.SSF.parse_date_code(serial, { date1904 });
  if (!p || !p.y) return null;
  const day = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (!p.H && !p.M && !p.S) return day;
  return `${day} ${pad(p.H)}:${pad(p.M)}:${pad(p.S)}`;
}

function cellValue(cell: XLSX.CellObject | undefined, date1904: boolean): unknown {
  if (!cell) return null;
  switch (cell.t) {
    case 'n': {
      const v = cell.v as number;
      if (cell.z && XLSX.SSF.is_date(cell.z as string)) return excelDate(v, date1904) ?? v;
      return v;
    }
    case 'b':
      return cell.v as boolean;
    case 'd':
      return cell.v instanceof Date ? cell.v.toISOString() : String(cell.v ?? '');
    case 's':
    case 'str' as XLSX.ExcelDataType:
      return cell.v === undefined || cell.v === null ? null : String(cell.v);
    case 'e':
    case 'z':
    default:
      return null;
  }
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Sheet cells → header row + data rows (blank rows dropped). */
function sheetRows(ws: XLSX.WorkSheet, date1904: boolean): unknown[][] {
  const byRow = new Map<number, unknown[]>();
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const { r, c } = XLSX.utils.decode_cell(addr);
    const v = cellValue(ws[addr] as XLSX.CellObject, date1904);
    if (isEmpty(v)) continue;
    let row = byRow.get(r);
    if (!row) {
      row = [];
      byRow.set(r, row);
    }
    row[c] = v;
  }
  return [...byRow.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const row = byRow.get(r) as unknown[];
      // Fill holes so JSON keeps the column positions.
      return Array.from({ length: row.length }, (_, i) => (i in row ? row[i] : null));
    });
}

function toSheet(name: string, all: unknown[][]): BlueprintSheet | null {
  if (all.length < 1) return null;
  const headers = (all[0] ?? []).map((h) => (h === null || h === undefined ? '' : String(h).trim()));
  const width = Math.max(headers.length, ...all.slice(1, 200).map((r) => r.length));
  while (headers.length < width) headers.push('');
  const data = all.slice(1);
  const rows = data.slice(0, MAX_ROWS_PER_SHEET);
  return {
    name,
    headers,
    rows,
    ...(data.length > rows.length ? { totalRows: data.length } : {}),
  };
}

/** Leave rows out (evenly per sheet) until the request fits the size cap. */
function fitPayload(sheets: BlueprintSheet[]): boolean {
  const size = JSON.stringify(sheets).length;
  if (size <= MAX_PAYLOAD_CHARS) return false;
  const factor = MAX_PAYLOAD_CHARS / size;
  for (const s of sheets) {
    const keep = Math.max(1, Math.floor(s.rows.length * factor));
    if (keep < s.rows.length) {
      s.totalRows = s.totalRows ?? s.rows.length;
      s.rows = s.rows.slice(0, keep);
    }
  }
  return true;
}

export async function parseSpreadsheet(file: File): Promise<ParsedFile> {
  const buf = await file.arrayBuffer();
  const sheets: BlueprintSheet[] = [];
  let encoding: string | undefined;

  if (isTextSpreadsheet(file.name)) {
    const decoded = decodeTextBytes(buf);
    encoding = decoded.encoding;
    // raw: every cell stays the text of the file.
    const wb = XLSX.read(decoded.text, { type: 'string', raw: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sheet = ws ? toSheet(baseName(file.name), sheetRows(ws, false)) : null;
    if (sheet && sheet.rows.length > 0) sheets.push(sheet);
  } else {
    const wb = XLSX.read(buf, { type: 'array', cellNF: true });
    const date1904 = !!wb.Workbook?.WBProps?.date1904;
    for (const name of wb.SheetNames) {
      const sheet = toSheet(name, sheetRows(wb.Sheets[name], date1904));
      if (sheet && sheet.rows.length > 0) sheets.push(sheet);
    }
  }

  const truncated = fitPayload(sheets) || sheets.some((s) => s.totalRows !== undefined);
  return { sheets, encoding, truncated };
}
