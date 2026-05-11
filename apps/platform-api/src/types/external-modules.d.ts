/**
 * Local ambient declarations for `papaparse` and `xlsx` so this code compiles
 * in environments where the real package types are not yet installed (CI
 * caches, fresh clones, restricted sandboxes). When `pnpm install` runs, the
 * actual `@types/papaparse` and `xlsx`'s bundled types take precedence — these
 * stubs are a safety net, not the source of truth.
 *
 * Intentionally narrow: we only declare the API surface used by the
 * data-import module. If we start using more of either library, extend
 * these declarations rather than fall back to `any`.
 */

declare module 'papaparse' {
  export interface ParseError {
    type: string;
    code: string;
    message: string;
    row?: number;
  }

  export interface ParseMeta {
    delimiter: string;
    linebreak: string;
    aborted: boolean;
    truncated: boolean;
    cursor: number;
    fields?: string[];
  }

  export interface ParseStepResult<T> {
    data: T;
    errors: ParseError[];
    meta: ParseMeta;
  }

  export interface ParseConfig<T = unknown> {
    delimiter?: string;
    newline?: string;
    quoteChar?: string;
    escapeChar?: string;
    header?: boolean;
    transformHeader?: (header: string, index: number) => string;
    dynamicTyping?: boolean;
    preview?: number;
    encoding?: string;
    worker?: boolean;
    comments?: boolean | string;
    download?: boolean;
    skipEmptyLines?: boolean | 'greedy';
    chunkSize?: number;
    step?: (results: ParseStepResult<T>, parser: Parser) => void;
    complete?: (results: ParseResult<T>) => void;
    error?: (err: Error, file?: File) => void;
    fastMode?: boolean;
    beforeFirstChunk?: (chunk: string) => string | void;
  }

  export interface ParseResult<T> {
    data: T[];
    errors: ParseError[];
    meta: ParseMeta;
  }

  export interface Parser {
    abort(): void;
    pause(): void;
    resume(): void;
  }

  export function parse<T = unknown>(
    input: string | NodeJS.ReadableStream,
    config?: ParseConfig<T>,
  ): ParseResult<T>;

  const _default: {
    parse: typeof parse;
  };
  export default _default;
}

declare module 'xlsx' {
  export interface WorkSheet {
    [cell: string]: unknown;
    '!ref'?: string;
  }
  export interface WorkBook {
    SheetNames: string[];
    Sheets: { [sheet: string]: WorkSheet };
  }
  export interface JSON2SheetOpts {
    header?: string[];
    skipHeader?: boolean;
  }
  export interface Sheet2JSONOpts {
    header?: 1 | 'A' | string[];
    range?: number | string;
    raw?: boolean;
    defval?: unknown;
    blankrows?: boolean;
  }

  export const utils: {
    sheet_to_json<T = unknown>(ws: WorkSheet, opts?: Sheet2JSONOpts): T[];
    decode_range(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } };
  };

  export function read(data: Buffer | ArrayBuffer | Uint8Array, opts?: {
    type?: 'buffer' | 'array' | 'string' | 'binary';
    cellDates?: boolean;
    cellNF?: boolean;
    sheetRows?: number;
    raw?: boolean;
  }): WorkBook;
}
