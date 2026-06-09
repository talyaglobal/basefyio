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

declare module 'class-validator' {
  export interface ValidationError {
    property: string;
    constraints?: Record<string, string>;
    children?: ValidationError[];
  }
  export function validateSync(object: object, options?: object): ValidationError[];
  export function IsString(options?: object): PropertyDecorator;
  export function IsNotEmpty(options?: object): PropertyDecorator;
  export function IsOptional(options?: object): PropertyDecorator;
  export function IsInt(options?: object): PropertyDecorator;
  export function IsNumber(options?: object, validatorOptions?: object): PropertyDecorator;
  export function IsBoolean(options?: object): PropertyDecorator;
  export function IsEnum(entity: object, options?: object): PropertyDecorator;
  export function IsArray(options?: object): PropertyDecorator;
  export function IsIn(array: unknown[], options?: object): PropertyDecorator;
  export function IsUUID(version?: string | number, options?: object): PropertyDecorator;
  export function IsUrl(options?: object, validatorOptions?: object): PropertyDecorator;
  export function Min(min: number, options?: object): PropertyDecorator;
  export function Max(max: number, options?: object): PropertyDecorator;
  export function MinLength(min: number, options?: object): PropertyDecorator;
  export function MaxLength(max: number, options?: object): PropertyDecorator;
  export function ValidateNested(options?: object): PropertyDecorator;
  export function IsObject(options?: object): PropertyDecorator;
  export function IsNotEmptyObject(options?: object): PropertyDecorator;
}

declare module 'minio' {
  import { Readable } from 'stream';
  export interface ClientOptions {
    endPoint: string;
    port?: number;
    useSSL?: boolean;
    accessKey: string;
    secretKey: string;
    region?: string;
    [key: string]: unknown;
  }
  export interface BucketItemStat {
    size: number;
    etag: string;
    lastModified: Date;
    metaData: Record<string, string>;
  }
  export class Client {
    constructor(options: ClientOptions);
    putObject(bucket: string, name: string, stream: Readable | Buffer | string, size?: number, metaData?: Record<string, string>): Promise<{ etag: string; versionId: string | null }>;
    removeObject(bucket: string, name: string): Promise<void>;
    getObject(bucket: string, name: string): Promise<Readable>;
    statObject(bucket: string, name: string): Promise<BucketItemStat>;
    listBuckets(): Promise<{ name: string; creationDate: Date }[]>;
    bucketExists(bucket: string): Promise<boolean>;
    makeBucket(bucket: string, region?: string): Promise<void>;
    removeBucket(bucket: string): Promise<void>;
    listObjectsV2(bucket: string, prefix?: string, recursive?: boolean): NodeJS.ReadableStream;
    listObjects(bucket: string, prefix?: string, recursive?: boolean): NodeJS.ReadableStream;
    getPartialObject(bucket: string, name: string, offset: number, length?: number): Promise<Readable>;
    fGetObject(bucket: string, name: string, filePath: string): Promise<void>;
    presignedGetObject(bucket: string, name: string, expiry?: number): Promise<string>;
    presignedPutObject(bucket: string, name: string, expiry?: number): Promise<string>;
    setBucketPolicy(bucket: string, policy: string): Promise<void>;
    getBucketPolicy(bucket: string): Promise<string>;
    removeObjects(bucket: string, names: string[]): Promise<void>;
    [key: string]: unknown;
  }
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
