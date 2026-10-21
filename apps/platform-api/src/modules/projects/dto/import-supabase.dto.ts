import {
  IsBoolean,
  IsString,
  IsNotEmpty,
  IsUrl,
  MinLength,
  IsOptional,
  IsUUID,
  IsIn,
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

  /**
   * 'sync' compares this project against the source and fetches only what it
   * has gained, instead of rebuilding everything. Requires existingProjectId.
   */
  @IsOptional()
  @IsIn(['full', 'sync'])
  mode?: 'full' | 'sync';

  /** Re-import into this basefyio project instead of creating a new one. Must belong to teamId. */
  @IsOptional()
  @IsUUID('4')
  existingProjectId?: string;

  /**
   * Sync only: before comparing, add the source's primary key to tables that
   * were imported without one (where the rows here are unique on it). Off by
   * default — building the index locks each repaired table for a moment.
   */
  @IsOptional()
  @IsBoolean()
  repairKeys?: boolean;
}
