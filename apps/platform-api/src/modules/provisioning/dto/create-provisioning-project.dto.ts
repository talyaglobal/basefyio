import {
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
}
