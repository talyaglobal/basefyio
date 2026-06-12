import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

export class CreateArchiveDto {
  @IsEnum(['USER_UPLOAD', 'WE_IMPORT'])
  source: 'USER_UPLOAD' | 'WE_IMPORT';

  @IsIn(['US', 'EU', 'TR'])
  region: string;

  @IsOptional()
  @IsString()
  retention?: string;
}
