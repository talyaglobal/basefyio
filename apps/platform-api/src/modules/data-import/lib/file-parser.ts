/**
 * Format-aware row reader for CSV, XLSX and JSON imports.
 *
 * Two surfaces:
 *   * `samplePreview(buffer, opts)` — synchronously yield up to N rows for
 *     the wizard's preview step. Used by the inspect endpoint.
 *   * `streamRows(buffer, onChunk)` — async chunked iteration over the full
 *     file for the import worker. Backed by Papaparse's stream API for CSV;
 *     for XLSX and JSON we materialize the rows (neither streams) and yield
 *     them in fixed-size chunks so the worker sees uniform shape.
 *
 * Both return a consistent `{ headers: string[], rows: unknown[][] }` shape
 * so downstream code (type inference, validation, insert) doesn't branch on
 * source format.
 *
 * Text formats are decoded through `decodeText`, which detects the character
 * set: a Windows-1254 CSV saved by Turkish Excel reads correctly instead of
 * turning every Turkish letter into U+FFFD.
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
import {
  decodeText,
  looksBinary,
  looksLikeZip,
  type ImportEncoding,
} from './text-decoding';

export type FileFormat = 'csv' | 'xlsx' | 'json';

/**
 * A problem with the uploaded file itself (not text, unparseable JSON, …).
 * The service turns it into a 400 with this message.
 */
export class ImportFileError extends Error {}

export interface ParsePreview {
  headers: string[];
  rows: unknown[][];
  /**
   * Total data rows in the file (the header is not counted). Exact when
   * `totalRowsExact`; otherwise extrapolated from the part that was parsed.
   */
  totalRowsApprox: number;
  /** True when the whole input was parsed, so the count is exact. */
  totalRowsExact: boolean;
  format: FileFormat;
  /** Character set the text was read with (text formats only). */
  encoding?: ImportEncoding;
  /** True when the encoding was detected rather than chosen by the user. */
  encodingDetected?: boolean;
  /** Plain-language notes for the wizard: encoding guesses, empty files, … */
  warnings: string[];
}

export interface ParseOptions {
  /** Character set of a text file; 'auto' (default) detects it. */
  encoding?: ImportEncoding | 'auto';
  /** The buffer is only the first slice of a larger object. */
  truncated?: boolean;
}

/** Default sample size for inspect. Tuned for "enough variety to guess types
 *  but small enough to keep inspect cheap on multi-GB files". */
export const DEFAULT_PREVIEW_ROWS = 1000;
/** Worker chunk size — balances pg parameter limit (65535 params per query)
 *  against round-trip overhead. With ~10 columns per row, 500 rows ≈ 5000
 *  params, well under the limit. */
export const WORKER_CHUNK_ROWS = 500;
/** Text up to this size is counted row by row for an exact total in the preview. */
const EXACT_COUNT_MAX_CHARS = 64 * 1024 * 1024;
/** JSON is parsed in one piece, so its size is capped well below the CSV limit. */
export const MAX_JSON_BYTES = 200 * 1024 * 1024;

const ENCODING_LABELS: Record<ImportEncoding, string> = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 (little-endian)',
  'utf-16be': 'UTF-16 (big-endian)',
  'windows-1254': 'Windows-1254 (Turkish)',
  'windows-1252': 'Windows-1252 (Western European)',
  'iso-8859-9': 'ISO-8859-9 (Turkish)',
};

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
  if (ext === 'json' || ext === 'ndjson' || ext === 'jsonl') return 'json';
  if (mime?.includes('csv')) return 'csv';
  if (mime?.includes('json')) return 'json';
  if (mime?.includes('spreadsheet') || mime?.includes('excel')) return 'xlsx';
  return null;
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
  opts: ParseOptions = {},
): ParsePreview {
  let preview: ParsePreview;
  if (format === 'csv') {
    preview = previewCsv(buffer, maxRows, firstRowIsHeader, opts);
  } else if (format === 'json') {
    preview = previewJson(buffer, maxRows, firstRowIsHeader, opts);
  } else {
    preview = previewXlsx(buffer, maxRows, firstRowIsHeader);
  }
  if (preview.headers.length > 0 && preview.rows.length === 0) {
    preview.warnings.push(
      firstRowIsHeader
        ? 'The file has a header row but no data rows, so nothing would be imported.'
        : 'The file has no data rows, so nothing would be imported.',
    );
  }
  return preview;
}

function syntheticHeaders(count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`column_${i + 1}`);
  return out;
}

/** Decode a text upload, refusing binaries renamed to a text extension. */
function decodeUpload(buffer: Buffer, opts: ParseOptions, kind: 'CSV' | 'JSON') {
  if (looksLikeZip(buffer)) {
    throw new ImportFileError(
      `This file is a packed document (for example an Excel workbook), not ${kind} text. ` +
        (kind === 'CSV'
          ? 'Upload it with its .xlsx extension, or save it from Excel as "CSV UTF-8".'
          : 'Export the data as JSON text and upload that.'),
    );
  }
  const decoded = decodeText(buffer, opts.encoding ?? 'auto', {
    mayBeTruncated: opts.truncated,
  });
  if (looksBinary(buffer, decoded.encoding)) {
    throw new ImportFileError(
      `This file does not look like ${kind} text (it contains binary data). ` +
        'Check that you picked the right file.',
    );
  }
  return decoded;
}

function encodingWarnings(decoded: {
  encoding: ImportEncoding;
  detected: boolean;
  replacementChars: number;
}): string[] {
  const warnings: string[] = [];
  if (decoded.detected && decoded.encoding !== 'utf-8') {
    warnings.push(
      `The file is not UTF-8, so it was read as ${ENCODING_LABELS[decoded.encoding]}. ` +
        'If letters look wrong in the preview, pick the right encoding.',
    );
  }
  if (decoded.replacementChars > 0) {
    warnings.push(
      `${decoded.replacementChars >= 1000 ? 'Over 1,000' : decoded.replacementChars} character(s) could not be read ` +
        `as ${ENCODING_LABELS[decoded.encoding]} and show as "\ufffd". Pick another encoding before importing.`,
    );
  }
  return warnings;
}

function previewCsv(
  buffer: Buffer,
  maxRows: number,
  firstRowIsHeader: boolean,
  opts: ParseOptions,
): ParsePreview {
  const decoded = decodeUpload(buffer, opts, 'CSV');
  const text = decoded.text;
  // `preview: maxRows + 1` so we include the header in the parser's accounting.
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy',
    preview: maxRows + 1,
    dynamicTyping: false,
  });

  const base = {
    format: 'csv' as const,
    encoding: decoded.encoding,
    encodingDetected: decoded.detected,
    warnings: encodingWarnings(decoded),
  };

  const allRows = (parsed.data as unknown[][]).filter((r) => Array.isArray(r));
  if (allRows.length === 0) {
    return { ...base, headers: [], rows: [], totalRowsApprox: 0, totalRowsExact: true };
  }

  const dataRowsParsed = allRows.length - (firstRowIsHeader ? 1 : 0);
  // Counting parsed records, not newlines: a quoted field may contain line
  // breaks, and the last line need not end with one. A file held in memory is
  // counted exactly with a second, non-materializing pass; only a range-fetched
  // slice of a larger object is extrapolated by bytes.
  let stoppedEarly = !!parsed.meta.truncated || !!opts.truncated;
  let totalRowsApprox = dataRowsParsed;
  if (stoppedEarly && !opts.truncated && text.length <= EXACT_COUNT_MAX_CHARS) {
    let records = 0;
    Papa.parse<string[]>(text, {
      header: false,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      step: () => {
        records++;
      },
    });
    totalRowsApprox = Math.max(0, records - (firstRowIsHeader ? 1 : 0));
    stoppedEarly = false;
  } else if (stoppedEarly) {
    const cursor = parsed.meta.cursor || text.length;
    totalRowsApprox = Math.max(
      dataRowsParsed,
      Math.round(dataRowsParsed * (text.length / Math.max(1, cursor))),
    );
  }

  if (firstRowIsHeader) {
    const headers = (allRows[0] as string[]).map((h) => String(h ?? ''));
    const rows = allRows.slice(1, maxRows + 1);
    return { ...base, headers, rows, totalRowsApprox, totalRowsExact: !stoppedEarly };
  }
  // No header: every parsed row is data. Synthesize column_1.. column_N from
  // the widest row's length so trailing-empty cells don't truncate the schema.
  const widest = allRows.reduce((m, r) => Math.max(m, (r as unknown[]).length), 0);
  const headers = syntheticHeaders(widest);
  const rows = allRows.slice(0, maxRows) as unknown[][];
  return { ...base, headers, rows, totalRowsApprox, totalRowsExact: !stoppedEarly };
}

function previewXlsx(
  buffer: Buffer,
  maxRows: number,
  firstRowIsHeader: boolean,
): ParsePreview {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, sheetRows: maxRows + 1 });
  } catch (err: any) {
    throw new ImportFileError(
      `This spreadsheet could not be opened: ${err?.message ?? 'unknown error'}.`,
    );
  }
  const empty: ParsePreview = {
    headers: [],
    rows: [],
    totalRowsApprox: 0,
    totalRowsExact: true,
    format: 'xlsx',
    warnings: [],
  };
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return empty;
  const sheet = wb.Sheets[sheetName];

  // header:1 returns array-of-arrays, including the header row at index 0.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: null,
    blankrows: false,
  });

  if (aoa.length === 0) return empty;
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

  // `sheetRows` trims `!ref` to the rows it read; the sheet's real extent is
  // kept in `!fullref`. (Re-reading with sheetRows: 1 — the old approach —
  // trimmed it to a single row, so every workbook previewed as "0 rows".)
  // SheetJS only sets `!fullref` when sheetRows actually cut rows off.
  const fullRef = sheet['!fullref'] as string | undefined;
  const readAll = !fullRef;
  let totalRowsApprox = rows.length;
  if (fullRef) {
    const range = XLSX.utils.decode_range(fullRef);
    totalRowsApprox = Math.max(
      rows.length,
      range.e.r - range.s.r + 1 - (firstRowIsHeader ? 1 : 0),
    );
  }
  return {
    headers,
    rows,
    totalRowsApprox,
    totalRowsExact: readAll,
    format: 'xlsx',
    warnings: [],
  };
}

/**
 * Turn a JSON document into header + rows. Accepts an array of objects, an
 * array of arrays (spreadsheet-like), an object wrapping one such array, or
 * newline-delimited JSON (one object per line). Nested objects/arrays become
 * JSON text so they infer as jsonb.
 */
export function parseJsonRecords(
  text: string,
  firstRowIsHeader: boolean,
): { headers: string[]; rows: unknown[][] } {
  const trimmed = text.trim();
  if (!trimmed) return { headers: [], rows: [] };

  let records: unknown[];
  try {
    const doc = JSON.parse(trimmed);
    if (Array.isArray(doc)) {
      records = doc;
    } else if (doc && typeof doc === 'object') {
      // { "data": [ ... ] } — use the single array-valued property when there is exactly one.
      const arrays = Object.values(doc as Record<string, unknown>).filter(Array.isArray);
      records = arrays.length === 1 ? (arrays[0] as unknown[]) : [doc];
    } else {
      throw new ImportFileError('The JSON file holds a single value, not records.');
    }
  } catch (err) {
    if (err instanceof ImportFileError) throw err;
    // Not one JSON document — try newline-delimited JSON.
    records = [];
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch (lineErr: any) {
        throw new ImportFileError(
          `The JSON file could not be parsed (line ${i + 1}: ${lineErr?.message ?? 'syntax error'}). ` +
            'Expected an array of objects, or one JSON object per line.',
        );
      }
    }
  }

  const toCell = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    return JSON.stringify(v);
  };

  if (records.length > 0 && records.every((r) => Array.isArray(r))) {
    const arrays = records as unknown[][];
    if (firstRowIsHeader) {
      return {
        headers: (arrays[0] ?? []).map((h) => String(h ?? '')),
        rows: arrays.slice(1).map((r) => r.map(toCell)),
      };
    }
    const widest = arrays.reduce((m, r) => Math.max(m, r.length), 0);
    return { headers: syntheticHeaders(widest), rows: arrays.map((r) => r.map(toCell)) };
  }

  // Objects: the header is every key seen, in first-appearance order.
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new ImportFileError(
        'Every record in the JSON file must be an object (or every record an array).',
      );
    }
    for (const key of Object.keys(r as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const rows = records.map((r) => headers.map((h) => toCell((r as Record<string, unknown>)[h])));
  return { headers, rows };
}

function decodeJson(buffer: Buffer, opts: ParseOptions) {
  if (buffer.length > MAX_JSON_BYTES) {
    throw new ImportFileError(
      `JSON files are limited to ${Math.round(MAX_JSON_BYTES / 1024 / 1024)} MB. ` +
        'Split the file, or convert it to CSV for larger imports.',
    );
  }
  return decodeUpload(buffer, opts, 'JSON');
}

function previewJson(
  buffer: Buffer,
  maxRows: number,
  firstRowIsHeader: boolean,
  opts: ParseOptions,
): ParsePreview {
  const decoded = decodeJson(buffer, opts);
  const { headers, rows } = parseJsonRecords(decoded.text, firstRowIsHeader);
  return {
    headers,
    rows: rows.slice(0, maxRows),
    totalRowsApprox: rows.length,
    totalRowsExact: true,
    format: 'json',
    encoding: decoded.encoding,
    encodingDetected: decoded.detected,
    warnings: encodingWarnings(decoded),
  };
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
 *
 * JSON path: parsed in one piece (size-capped by MAX_JSON_BYTES), then chunked.
 */
export async function streamRows(
  buffer: Buffer,
  format: FileFormat,
  onChunk: (headers: string[], rows: unknown[][]) => Promise<void>,
  opts: { chunkSize?: number; firstRowIsHeader?: boolean; encoding?: ImportEncoding | 'auto' } = {},
): Promise<{ totalRows: number; encoding?: ImportEncoding }> {
  const chunkSize = opts.chunkSize ?? WORKER_CHUNK_ROWS;
  const firstRowIsHeader = opts.firstRowIsHeader ?? true;
  if (format === 'csv') {
    return streamRowsCsv(buffer, onChunk, chunkSize, firstRowIsHeader, opts.encoding ?? 'auto');
  }
  if (format === 'json') {
    const decoded = decodeJson(buffer, { encoding: opts.encoding ?? 'auto' });
    const { headers, rows } = parseJsonRecords(decoded.text, firstRowIsHeader);
    for (let i = 0; i < rows.length; i += chunkSize) {
      await onChunk(headers, rows.slice(i, i + chunkSize));
    }
    return { totalRows: rows.length, encoding: decoded.encoding };
  }
  return streamRowsXlsx(buffer, onChunk, chunkSize, firstRowIsHeader);
}

async function streamRowsCsv(
  buffer: Buffer,
  onChunk: (headers: string[], rows: unknown[][]) => Promise<void>,
  chunkSize: number,
  firstRowIsHeader: boolean,
  encoding: ImportEncoding | 'auto',
): Promise<{ totalRows: number; encoding: ImportEncoding }> {
  // Papaparse's Node stream mode wants a Readable. We adapt the buffer.
  const decoded = decodeUpload(buffer, { encoding }, 'CSV');
  const stream = Readable.from([decoded.text]);

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

  return { totalRows, encoding: decoded.encoding };
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
