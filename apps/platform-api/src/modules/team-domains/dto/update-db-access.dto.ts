import { ArrayMaxSize, IsArray, IsBoolean, IsString, MaxLength } from 'class-validator';
import { MAX_ALLOWED_CIDRS } from '../../pgbouncer/pgbouncer-hba';

export class UpdateDbAccessDto {
  /** Refuse external connections that do not negotiate TLS. */
  @IsBoolean()
  requireTls!: boolean;

  /** Addresses or CIDR ranges allowed to connect; empty = any address. */
  @IsArray()
  @ArrayMaxSize(MAX_ALLOWED_CIDRS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedCidrs!: string[];
}
