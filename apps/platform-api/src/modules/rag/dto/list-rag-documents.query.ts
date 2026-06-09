import { Type } from 'class-transformer';
import { IsOptional, IsIn, IsInt, Min, Max } from 'class-validator';

export class ListRagDocumentsQuery {
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSING', 'INDEXED', 'FAILED', 'STALE'])
  status?: 'PENDING' | 'PROCESSING' | 'INDEXED' | 'FAILED' | 'STALE';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
