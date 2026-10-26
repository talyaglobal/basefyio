import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

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
}
