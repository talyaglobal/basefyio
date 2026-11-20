import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { COMPUTE_TIERS, PROJECT_REGIONS, type ComputeTierId, type ProjectRegion } from '../project-compute';

/** Data access settings chosen in the New project dialog (Settings → Data access later). */
export class DataAccessDto {
  /** The REST data API serves this project. Default true. */
  @IsBoolean()
  dataApi!: boolean;

  /** New `public` tables are granted to `anon` / `authenticated` automatically. Default true. */
  @IsBoolean()
  autoGrantNewTables!: boolean;

  /** Row-level security is enabled on every new `public` table. Default false. */
  @IsBoolean()
  rlsOnNewTables!: boolean;
}

/** Settings → Data access: any subset of the three switches. */
export class UpdateDataAccessDto {
  @IsOptional()
  @IsBoolean()
  dataApi?: boolean;

  @IsOptional()
  @IsBoolean()
  autoGrantNewTables?: boolean;

  @IsOptional()
  @IsBoolean()
  rlsOnNewTables?: boolean;
}

/** Settings → API: the extra schemas the REST data API serves (#264). */
export class UpdateRestSchemasDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  exposedSchemas!: string[];
}

/**
 * Everything the dashboard and the CLI send to create a project. The class
 * is the whole contract: the global pipe whitelists these fields and rejects
 * any other, so a field the wizard grows later has to be declared here
 * before it can reach the service.
 */
export class CreateProjectDto {
  @IsUUID()
  teamId!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(64)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(256)
  description?: string;

  /** Database model chosen in the New Project wizard. Defaults to RELATIONAL. */
  @IsOptional()
  @IsIn(['RELATIONAL', 'NOSQL'])
  databaseType?: 'RELATIONAL' | 'NOSQL';

  /**
   * The database password. Omitted or empty: the server generates one. The service also
   * applies the rotation rules (upper and lower case, a number, a special character).
   */
  @IsOptional()
  @IsString()
  @Matches(/^$|^\S{12,128}$/, { message: 'dbPassword must be 12 to 128 characters without spaces' })
  @Matches(/^$|^(?=.*[A-Za-z])(?=.*[0-9])/, { message: 'dbPassword must contain letters and digits' })
  dbPassword?: string;

  /** `shared` (default) or a dedicated size; the server refuses a size the plan or region cannot place. */
  @IsOptional()
  @IsIn([...COMPUTE_TIERS])
  computeTier?: ComputeTierId;

  /** Where the data lives. `eu-central` is the only region today. */
  @IsOptional()
  @IsIn([...PROJECT_REGIONS])
  region?: ProjectRegion;

  @IsOptional()
  @ValidateNested()
  @Type(() => DataAccessDto)
  dataAccess?: DataAccessDto;
}
