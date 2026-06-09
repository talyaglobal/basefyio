import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum OperationTypeDto {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  ROLLBACK = 'ROLLBACK',
}

export class CreateProvisioningOperationDto {
  @IsUUID()
  provisioningProjectId: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @IsEnum(OperationTypeDto)
  type: OperationTypeDto;

  // Required explicitly at the API layer — no default accepted from the client.
  @IsBoolean()
  dryRun: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  idempotencyKey: string;

  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
