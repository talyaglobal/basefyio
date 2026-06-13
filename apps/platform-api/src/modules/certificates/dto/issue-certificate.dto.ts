import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export class IssueCertificateDto {
  @IsOptional()
  @IsIn(['READ', 'READ_WRITE'])
  accessLevel?: 'READ' | 'READ_WRITE';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(730)
  ttlDays?: number;
}
