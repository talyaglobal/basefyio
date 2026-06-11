import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum ListOperationsStatus {
  PENDING        = 'PENDING',
  RUNNING        = 'RUNNING',
  COMPLETED      = 'COMPLETED',
  FAILED         = 'FAILED',
  PARTIAL_FAILED = 'PARTIAL_FAILED',
  DRY_RUN        = 'DRY_RUN',
  CANCELLED      = 'CANCELLED',
  ROLLED_BACK    = 'ROLLED_BACK',
}

export class ListOperationsQuery {
  @IsUUID()
  projectId: string;

  @IsOptional()
  @IsEnum(ListOperationsStatus)
  status?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
