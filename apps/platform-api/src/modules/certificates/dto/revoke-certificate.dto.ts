import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RevokeCertificateDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string;
}
