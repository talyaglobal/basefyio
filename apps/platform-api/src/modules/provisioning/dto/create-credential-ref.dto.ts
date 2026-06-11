import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateCredentialRefDto {
  @IsUUID()
  teamId: string;

  /**
   * Human-readable label for this credential reference.
   * Stored as `label` on the Prisma model.
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  label: string;

  /**
   * OpenBao/Vault-style path to the secret, e.g. "secret/hetzner/prod".
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  openbaoPath: string;

  /**
   * Provider this credential is for. Defaults to "hetzner" on the model.
   */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  provider?: string;
}
