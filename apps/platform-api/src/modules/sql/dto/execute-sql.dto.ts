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
   * They travel apart from the statement for two reasons, and the first one is
   * the one people hit. `sql-guard.ts` scans the statement it is given for
   * forbidden operations, and it scans the whole text — string literals
   * included, because a literal is where a smuggled `COPY` would hide. So an
   * ordinary value inlined into SQL ("page load", "grant access", a refusal
   * message that says "copy") is refused as if it were the operation it names.
   * A value sent here is never part of the statement, so it is never scanned as
   * one, and the guard keeps reading every character of the SQL that will run.
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
}
