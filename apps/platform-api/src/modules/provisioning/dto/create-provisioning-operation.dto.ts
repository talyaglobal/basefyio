import {
  IsBoolean,
  IsEnum,
  IsObject,
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
  /** Platform project ID — the service resolves the provisioning project from this. */
  @IsUUID()
  projectId: string;

  @IsEnum(OperationTypeDto)
  type: OperationTypeDto;

  /**
   * Stable caller-supplied key.
   *   Same key + compatible payload → idempotent replay (200, idempotent: true).
   *   Same key + incompatible payload (different type/dryRun/desiredSpec) → 409.
   *   Different key → new operation.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  idempotencyKey: string;

  /** Provider-specific operation spec stored as input on the operation row. */
  @IsObject()
  desiredSpec: Record<string, unknown>;

  /** Required explicitly — no server-side default. */
  @IsBoolean()
  dryRun: boolean;
}
