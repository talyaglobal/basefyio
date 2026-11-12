import {
  IsNotEmpty,
  IsString,
  IsUUID,
  IsInt,
  IsOptional,
  IsBoolean,
  IsArray,
  ArrayMaxSize,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ExecuteSqlDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  query!: string;

  /**
   * Values for the `$1 … $n` placeholders in `query`.
   *
   * They travel apart from the statement for two reasons. `sql-guard.ts` scans
   * the statement it is given for forbidden operations, string literals
   * included, because a literal is where a smuggled `COPY` would hide. It reads
   * a literal as SQL of its own, so an ordinary sentence ("page load", "copy
   * that") passes — but a value whose text is itself a statement ("grant all
   * on t to x") would still be refused. A value sent here is never part of the
   * statement, so it is never scanned as one, and the guard keeps reading every
   * character of the SQL that will run.
   *
   * The second is the usual one: a bound value cannot become syntax, whatever
   * quotes it contains.
   *
   * 65535 is Postgres' own ceiling on bound parameters per statement.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(65535)
  params?: unknown[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @IsBoolean()
  countTotal?: boolean;

  /**
   * Run the statement in a READ ONLY transaction. The SQL editor sets this
   * when it runs a query again to fetch another page: a statement that writes
   * is then refused instead of repeating its write.
   */
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;

  /**
   * Cap on the rows returned by a statement that cannot be paged (a script,
   * a data-modifying statement). Extra rows are dropped and `truncated` is set.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  maxRows?: number;

  /** Omit `resultSets` when it would only repeat `rows` (a single statement). */
  @IsOptional()
  @IsBoolean()
  compact?: boolean;

  /**
   * An id the dashboard picks for this run, so the same user can cancel it
   * with POST /sql/cancel while it is still executing.
   */
  @IsOptional()
  @IsUUID()
  runId?: string;
}

export class CancelSqlDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsUUID()
  @IsNotEmpty()
  runId!: string;
}

export class CreateSqlSnippetDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  query!: string;
}

export class UpdateSqlSnippetDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  query?: string;
}
