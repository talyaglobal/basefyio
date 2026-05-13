import { IsNotEmpty, IsString, IsUUID, IsInt, IsOptional, IsBoolean, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class ExecuteSqlDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  query!: string;

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
