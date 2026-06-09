import {
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateProvisioningProjectDto {
  @IsUUID()
  projectId: string;

  @IsUUID()
  credentialRefId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(30)
  region: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  datacenter?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  provider?: string;

  /** Caller-supplied spec for this provisioning project (provider-specific config). */
  @IsObject()
  desiredSpec: Record<string, unknown>;

  /**
   * Must be true (dry-run) or false (real apply).
   * No server-side default — callers must be explicit about intent.
   */
  @IsBoolean()
  dryRun: boolean;

  /**
   * Stable key supplied by caller. Re-sending the same key for the same
   * projectId returns the existing operation instead of creating a second one.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  idempotencyKey: string;
}
