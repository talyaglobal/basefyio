import { IsString, MaxLength } from 'class-validator';

export class ClaimSubdomainDto {
  /** The workspace address to claim, e.g. "technoplatz" for technoplatz.<base domain>. */
  @IsString()
  @MaxLength(100)
  subdomain!: string;
}
