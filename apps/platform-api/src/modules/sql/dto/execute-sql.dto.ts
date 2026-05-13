import { IsNotEmpty, IsString, IsUUID, IsInt, IsOptional, IsBoolean, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class ExecuteSqlDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  query!: string;

  /** 1-based page index. Only honoured for SELECT-shape queries. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Rows per page (1-1000). Defaults to 100 server-side. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  /** If true, also runs a bounded COUNT(*) — typically only sent on page 1. */
  @IsOptional()
  @IsBoolean()
  countTotal?: boolean;
}
