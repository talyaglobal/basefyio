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

import Papa from 'papaparse';
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

function estimateCsvRowCount(buf: Buffer): number {
  // Count \n in the buffer; subtract 1 for the header.
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return Math.max(0, n - 1);
}

/**
 * Synchronous preview reader. Both branches read the full buffer (preview is
 * called on user-bounded uploads, not multi-GB streams).
 */
export function samplePreview(
  buffer: Buffer,
  format: FileFormat,
  maxRows: number = DEFAULT_PREVIEW_ROWS,
): ParsePreview {
  if (format === 'csv') {
    return previewCsv(buffer, maxRows);
  }
  return previewXlsx(buffer, maxRows);
}

function previewCsv(buffer: Buffer, maxRows: number): ParsePreview {
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
  const headers = (allRows[0] as string[]).map((h) => String(h ?? ''));
  const rows = allRows.slice(1, maxRows + 1);
  return {
    headers,
    rows,
    totalRowsApprox: estimateCsvRowCount(buffer),
    format: 'csv',
  };
}

function previewXlsx(buffer: Buffer, maxRows: number): ParsePreview {
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
  const headers = (aoa[0] as unknown[]).map((h) => String(h ?? ''));
  const rows = aoa.slice(1, maxRows + 1);

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
  opts: { chunkSize?: number } = {},
): Promise<{ totalRows: number }> {
  const chunkSize = opts.chunkSize ?? WORKER_CHUNK_ROWS;
  if (format === 'csv') {
    return streamRowsCsv(buffer, onChunk, chunkSize);
  }
  return streamRowsXlsx(buffer, onChunk, chunkSize);
}

async function streamRowsCsv(
  buffer: Buffer,
  onChunk: (headers: string[], rows: unknown[][]) => Promise<void>,
  chunkSize: number,
): Promise<{ totalRows: number }> {
  // Papaparse's Node stream mode wants a Readable. We adapt the buffer.
  const text = stripBom(buffer.toString('utf8'));
  const stream = Readable.from([text]);

  let headers: string[] | null = null;
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
        if (headers === null) {
          headers = row.map((h) => String(h ?? ''));
          return;
        }
        batch.push(row);
        totalRows++;
        if (batch.length >= chunkSize) {
          parser.pause();
          try {
            await onChunk(headers, batch);
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

  const headers = (aoa[0] as unknown[]).map((h) => String(h ?? ''));
  let total = 0;
  for (let i = 1; i < aoa.length; i += chunkSize) {
    const batch = aoa.slice(i, i + chunkSize);
    total += batch.length;
    await onChunk(headers, batch as unknown[][]);
  }
  return { totalRows: total };
}
