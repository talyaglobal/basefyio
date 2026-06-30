import {
  IsString,
  IsNotEmpty,
  IsUrl,
  MinLength,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class ImportSupabaseDto {
  @IsUrl({ require_tld: false }, { message: 'Invalid Supabase URL' })
  @IsNotEmpty()
  supabaseUrl: string;

  @IsString()
  @IsNotEmpty()
  serviceRoleKey: string;

  /** Optional: direct Postgres read fallback when PostgREST cannot read a table (rare if service_role is correct). */
  @IsOptional()
  @IsString()
  databasePassword?: string;

  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  @IsNotEmpty()
  teamId: string;

  /** Re-import into this basefyio project instead of creating a new one. Must belong to teamId. */
  @IsOptional()
  @IsUUID('4')
  existingProjectId?: string;
}
