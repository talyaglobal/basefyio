import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IMPORT_ENCODINGS } from '../lib/text-decoding';

/**
 * One row of the column-map: which source column flows to which destination
 * column, and how to coerce it. The processor uses this to drive validation
 * + insert.
 */
export class ColumnMappingDto {
  /** Original source column name (header in the uploaded file). */
  @IsString()
  source!: string;

  /** Target Postgres column name (must already exist for `existing` mode,
   *  or be a freshly named column for `new` mode). */
  @IsString()
  target!: string;

  /**
   * Postgres type to coerce to. Allowed values match InferredType in
   * type-inferrer.ts. For `existing` mode this should match the column's
   * actual DB type; mismatches surface as bad-row errors.
   */
  @IsString()
  type!:
    | 'boolean'
    | 'integer'
    | 'bigint'
    | 'numeric'
    | 'uuid'
    | 'date'
    | 'timestamptz'
    | 'jsonb'
    | 'text';

  @IsOptional()
  nullable?: boolean;
}

/**
 * How text values are read: the file's decimal separator and date order
 * (Turkish files write 1.234,56 and 31.12.1999), and what an empty or padded
 * text cell becomes. Detected by /inspect; the wizard lets the user override.
 */
export class ValueFormatDto {
  @IsOptional()
  @IsIn(['.', ','])
  decimalSeparator?: '.' | ',';

  @IsOptional()
  @IsIn(['DMY', 'MDY'])
  dateOrder?: 'DMY' | 'MDY';

  /** Text columns: an empty cell becomes NULL (default) or an empty string. */
  @IsOptional()
  @IsBoolean()
  emptyAsNull?: boolean;

  /** Text columns: strip surrounding spaces (default) or keep them. */
  @IsOptional()
  @IsBoolean()
  trimText?: boolean;
}

export class StartImportDto {
  /** MinIO object key returned by /inspect for the FIRST file. The worker
   *  fetches the file by this key — no second upload. */
  @IsString()
  sourceKey!: string;

  /** Additional MinIO source keys when the user uploaded multiple files in
   *  the same wizard session. All files are assumed to share the schema
   *  detected from `sourceKey`. The worker processes them sequentially,
   *  applying the same column map / conflict mode / type rules. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  additionalSourceKeys?: string[];

  /** Original filename (for activity log / error report only). */
  @IsString()
  filename!: string;

  /** csv, xlsx or json. */
  @IsIn(['csv', 'xlsx', 'json'])
  format!: 'csv' | 'xlsx' | 'json';

  /** Character set of CSV/JSON files. Omitted or 'auto' detects it per file. */
  @IsOptional()
  @IsIn([...IMPORT_ENCODINGS, 'auto'])
  encoding?: (typeof IMPORT_ENCODINGS)[number] | 'auto';

  /** Number/date conventions and text rules applied while casting cells. */
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ValueFormatDto)
  valueFormat?: ValueFormatDto;

  /** When false, the worker treats row 0 as data and matches the synthetic
   *  column_1..N names emitted by /inspect with firstRowIsHeader=false. */
  @IsOptional()
  firstRowIsHeader?: boolean;

  /** existing = insert into an existing table; new = CREATE TABLE then insert. */
  @IsIn(['existing', 'new'])
  targetMode!: 'existing' | 'new';

  /** Schema-qualified target table name component (just the table; schema
   *  resolved by the worker using ProjectDataService.resolveSchema). */
  @IsString()
  tableName!: string;

  /** Schema override; if omitted the worker auto-resolves like Table Editor. */
  @IsOptional()
  @IsString()
  schemaName?: string;

  /** What to do when a row's PK / unique-constrained columns conflict with
   *  an existing row. */
  @IsIn(['skip', 'update', 'fail'])
  conflictMode!: 'skip' | 'update' | 'fail';

  /** Column(s) used as the conflict target. Required for skip/update modes;
   *  ignored for `fail` mode. Must be unique-constrained in the DB. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  conflictColumns?: string[];

  /** Mapping: every source column the user wants imported. Source columns
   *  not listed are dropped. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ColumnMappingDto)
  columns!: ColumnMappingDto[];
}

export class InspectImportResultDto {
  sourceKey!: string;
  filename!: string;
  format!: 'csv' | 'xlsx' | 'json';
  totalRowsApprox!: number;
  /** True when every row was parsed, so totalRowsApprox is an exact count. */
  totalRowsExact!: boolean;
  /** Character set the text was read with (CSV/JSON only). */
  encoding?: string;
  /** True when that character set was detected rather than chosen. */
  encodingDetected?: boolean;
  /** Decimal separator and date order detected from the sample. */
  detectedFormat!: { decimalSeparator: '.' | ','; dateOrder: 'DMY' | 'MDY' };
  /** Plain-language notes for the wizard (encoding guesses, empty files, …). */
  warnings!: string[];
  headers!: string[];
  /** Inferred columns with sample values for the UI. */
  inferredColumns!: Array<{
    name: string;
    originalName: string;
    type: string;
    nullable: boolean;
    sampleValues: string[];
  }>;
  /** First N parsed rows (already aligned to headers) for preview. */
  sampleRows!: unknown[][];
  /** Existing tables in the project so the wizard can offer "import into…". */
  existingTables!: Array<{ schema: string; name: string }>;
  /** Echo of the flag the inspect ran with so the UI can keep the toggle in sync. */
  firstRowIsHeader!: boolean;
}
