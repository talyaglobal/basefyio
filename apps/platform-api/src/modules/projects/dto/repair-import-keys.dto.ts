import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

/**
 * Add the source's primary keys to imported tables that arrived without one.
 *
 * The source URL and keys are re-entered because the platform keeps neither;
 * the same is true of a re-import. With a database password the key comes
 * from the source catalogue; without one, from the API's schema description.
 */
export class RepairImportKeysDto {
  @IsUrl({ require_tld: false }, { message: 'Invalid Supabase URL' })
  @IsNotEmpty()
  supabaseUrl: string;

  @IsString()
  @IsNotEmpty()
  serviceRoleKey: string;

  @IsOptional()
  @IsString()
  databasePassword?: string;

  /** Report what would be done without running any DDL. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** Only these tables; defaults to every table without a key. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  tables?: string[];
}
