/**
 * Format-aware row reader for CSV and XLSX imports.
 *
 * Two surfaces:
 *   * `samplePreview(buffer, opts)` — synchronously yield up to N rows for
 *     the wizard's preview step. Used by the inspect endpoint.
 *   * `streamRows(buffer, onChunk)` — async chunked iteration over the full
 *     file for the import worker. Backed by Papaparse's stream API for CSV;
 *     for XLSX we materialize the sheet (SheetJS doesn't expose streams) and
 *     yield rows in fixed-size chunks so the worker sees uniform shape.
 *
 * Both return a consistent `{ headers: string[], rows: unknown[][] }` shape
 * so downstream code (type inference, validation, insert) doesn't branch on
 * source format.
 */

// Use a namespace import (not `import Papa from 'papaparse'`) because the
// platform-api tsconfig has `esModuleInterop: false`. With the default-import
// form, TypeScript compiles to `require('papaparse').default`, but Papaparse
// is a CommonJS module whose `module.exports` is the namespace itself — there
// is no `.default`. The result is `Papa === undefined` at runtime and the
// /inspect endpoint 500s with "Cannot read properties of undefined (reading
// 'parse')". The namespace form compiles to `require('papaparse')` which is
// the actual module and gives us `Papa.parse(...)` as expected.
import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { Readable } from 'node:stream';

export type FileFormat = 'csv' | 'xlsx';

export interface ParsePreview {
  headers: string[];
  rows: unknown[][];
  /**
   * Approximate total rows in the file. CSV: estimated from buffer scan
   * (lines minus header). XLSX: exact, from sheet range.
   */
  totalRowsApprox: number;
  format: FileFormat;
}

/** Default sample size for inspect. Tuned for "enough variety to guess types
 *  but small enough to keep inspect cheap on multi-GB files". */
export const DEFAULT_PREVIEW_ROWS = 1000;
/** Worker chunk size — balances pg parameter limit (65535 params per query)
 *  against round-trip overhead. With ~10 columns per row, 500 rows ≈ 5000
 *  params, well under the limit. */
export const WORKER_CHUNK_ROWS = 500;

/**
 * Detect format from filename + mime hint. Returns `null` for unknown.
 * Mime-only detection is unreliable (browsers send `application/vnd.ms-excel`
 * for CSV in some locales), so we trust extension when available.
 */
export function detectFormat(
  filename: string,
  mime?: string,
): FileFormat | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return 'xlsx';
  if (mime?.includes('csv')) return 'csv';
  if (mime?.includes('spreadsheet') || mime?.includes('excel')) return 'xlsx';
  return null;
}

function estimateCsvRowCount(buf: Buffer, subtractHeader: boolean = true): number {
  // Count \n in the buffer; optionally subtract 1 for the header.
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return Math.max(0, subtractHeader ? n - 1 : n);
}

/**
 * Synchronous preview reader. Both branches read the full buffer (preview is
 * called on user-bounded uploads, not multi-GB streams).
 */
export function samplePreview(
  buffer: Buffer,
  format: FileFormat,
  maxRows: number = DEFAULT_PREVIEW_ROWS,
  /**
   * When false, row 0 is treated as data and synthetic column names
   * (`column_1`, `column_2`, …) are generated. Use this for CSVs that come
   * out of legacy exports / fixed-width dumps with no header line.
   */
  firstRowIsHeader: boolean = true,
): ParsePreview {
  if (format === 'csv') {
    return previewCsv(buffer, maxRows, firstRowIsHeader);
  }
  return previewXlsx(buffer, maxRows, firstRowIsHeader);
}

function syntheticHeaders(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`column_${i + 1}`);
  return out;
}

function previewCsv(
  buffer: Buffer,
  maxRows: number,
  firstRowIsHeader: boolean,
): ParsePreview {
  // Strip BOM if present; Papaparse handles it but it's cheap to be safe.
  const text = stripBom(buffer.toString('utf8'));
  // `preview: maxRows + 1` so we include the header in the parser's accounting.
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    preview: maxRows + 1,
    dynamicTyping: false,
  });

  const allRows = (parsed.data as unknown[][]).filter((r) => Array.isArray(r));
  if (allRows.length === 0) {
    return { headers: [], rows: [], totalRowsApprox: 0, format: 'csv' };
  }
  if (firstRowIsHeader) {
    const headers = (allRows[0] as string[]).map((h) => String(h ?? ''));
    const rows = allRows.slice(1, maxRows + 1);
    return {
      headers,
      rows,
      totalRowsApprox: estimateCsvRowCount(buffer, true),
      format: 'csv',
    };
  }
  // No header: every parsed row is data. Synthesize column_1.. column_N from
  // the widest row's length so trailing-empty cells don't truncate the schema.
  const widest = allRows.reduce((m, r) => Math.max(m, (r as unknown[]).length), 0);
  const headers = syntheticHeaders(widest);
  const rows = allRows.slice(0, maxRows) as unknown[][];
  return {
    headers,
    rows,
    totalRowsApprox: estimateCsvRowCount(buffer, false),
    format: 'csv',
  };
}

function previewXlsx(
  buffer: Buffer,
  maxRows: number,
  firstRowIsHeader: boolean,
): ParsePreview {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, sheetRows: maxRows + 1 });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headers: [], rows: [], totalRowsApprox: 0, format: 'xlsx' };
  const sheet = wb.Sheets[sheetName];

  // header:1 returns array-of-arrays, including the header row at index 0.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: false,
  });

  if (aoa.length === 0) {
    return { headers: [], rows: [], totalRowsApprox: 0, format: 'xlsx' };
  }
  let headers: string[];
  let rows: unknown[][];
  if (firstRowIsHeader) {
    headers = (aoa[0] as unknown[]).map((h) => String(h ?? ''));
    rows = aoa.slice(1, maxRows + 1);
  } else {
    const widest = aoa.reduce((m, r) => Math.max(m, (r as unknown[]).length), 0);
    headers = syntheticHeaders(widest);
    rows = aoa.slice(0, maxRows);
  }

  // Re-read just the range to count total rows accurately. sheetRows above
  // limited what was materialized; the range header still reflects total.
  const fullWb = XLSX.read(buffer, { type: 'buffer', cellDates: true, sheetRows: 1 });
  const fullSheet = fullWb.Sheets[fullWb.SheetNames[0]!];
  const ref = fullSheet?.['!ref'];
  const totalRowsApprox = ref
    ? Math.max(0, XLSX.utils.decode_range(ref).e.r) // 0-indexed end row = header + body − 1
    : rows.length;
  return { headers, rows, totalRowsApprox, format: 'xlsx' };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Async row stream. The callback receives chunks of up to WORKER_CHUNK_ROWS
 * already-aligned rows. Returns when the file is fully consumed.
 *
 * CSV path: uses Papaparse's `step` callback to avoid materializing the whole
 * file. We buffer rows into chunks ourselves so each `onChunk` call sees a
 * predictable batch size.
 *
 * XLSX path: SheetJS does not stream — we materialize the workbook then yield
 * in chunks. For very large XLSX (>500MB) this can be expensive; we treat
 * Excel-sized files (a few hundred MB at worst) as a known limit and surface
 * it in the wizard.
 */
export async function streamRows(
  buffer: Buffer,
  format: FileFormat,
  onChunk: (headers: string[], rows: unknown[][]) => Promise<void>,
  opts: { chunkSize?: number; firstRowIsHeader?: boolean } = {},
): Promise<{ totalRows: number }> {
  const chunkSize = opts.chunkSize ?? WORKER_CHUNK_ROWS;
  const firstRowIsHeader = opts.firstRowIsHeader ?? true;
  if (format === 'csv') {
    return streamRowsCsv(buffer, onChunk, chunkSize, firstRowIsHeader);
  }
  return streamRowsXlsx(buffer, onChunk, chunkSize, firstRowIsHeader);
}

async function streamRowsCsv(
  buffer: Buffer,
  onChunk: (headers: string[], rows: unknown[][]) => Promise<void>,
  chunkSize: number,
  firstRowIsHeader: boolean,
): Promise<{ totalRows: number }> {
  // Papaparse's Node stream mode wants a Readable. We adapt the buffer.
  const text = stripBom(buffer.toString('utf8'));
  const stream = Readable.from([text]);

  // When the file has no header row we synthesize column_1..N from the FIRST
  // observed row's length. Set after we see row 0 below.
  let headers: string[] | null = firstRowIsHeader ? null : [];
  let batch: unknown[][] = [];
  let totalRows = 0;
  // Collect errors but don't abort — the worker validates and reports per-row.
  await new Promise<void>((resolve, reject) => {
    Papa.parse<string[]>(stream as unknown as NodeJS.ReadableStream, {
      header: false,
      skipEmptyLines: 'greedy',
      worker: false,
      dynamicTyping: false,
      step: async (result, parser) => {
        const row = result.data as unknown[];
        if (!Array.isArray(row)) return;
        if (firstRowIsHeader && headers === null) {
          headers = row.map((h) => String(h ?? ''));
          return;
        }
        if (!firstRowIsHeader && headers !== null && headers.length === 0) {
          // Lazy-init synthetic headers from the first observed data row.
          headers = syntheticHeaders(row.length);
        }
        batch.push(row);
        totalRows++;
        if (batch.length >= chunkSize && headers !== null) {
          // headers is guaranteed non-null here: either the file had a header
          // and we set it on row 0, or no-header mode lazy-set it from the
          // first data row above. The null-check keeps TS happy.
          const safeHeaders = headers;
          parser.pause();
          try {
            await onChunk(safeHeaders, batch);
            batch = [];
            parser.resume();
          } catch (e) {
            parser.abort();
            reject(e);
          }
        }
      },
      complete: async () => {
        if (headers !== null && batch.length > 0) {
          try {
            await onChunk(headers, batch);
            batch = [];
          } catch (e) {
            return reject(e);
          }
        }
        resolve();
      },
      error: (err) => reject(err),
    });
  });

  return { totalRows };
}

async function streamRowsXlsx(
  buffer: Buffer,
  onChunk: (headers: string[], rows: unknown[][]) => Promise<void>,
  chunkSize: number,
  firstRowIsHeader: boolean,
): Promise<{ totalRows: number }> {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { totalRows: 0 };
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: false,
  });
  if (aoa.length === 0) return { totalRows: 0 };

  let headers: string[];
  let firstDataRow: number;
  if (firstRowIsHeader) {
    headers = (aoa[0] as unknown[]).map((h) => String(h ?? ''));
    firstDataRow = 1;
  } else {
    const widest = aoa.reduce((m, r) => Math.max(m, (r as unknown[]).length), 0);
    headers = syntheticHeaders(widest);
    firstDataRow = 0;
  }
  let total = 0;
  for (let i = firstDataRow; i < aoa.length; i += chunkSize) {
    const batch = aoa.slice(i, i + chunkSize);
    total += batch.length;
    await onChunk(headers, batch as unknown[][]);
  }
  return { totalRows: total };
}
