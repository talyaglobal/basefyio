import { IsString, IsNotEmpty, IsUrl, MinLength, IsBoolean, IsOptional } from 'class-validator';

export class ImportSupabaseDto {
  @IsUrl({ require_tld: false }, { message: 'Invalid Supabase URL' })
  @IsNotEmpty()
  supabaseUrl: string;

  @IsString()
  @IsNotEmpty()
  serviceRoleKey: string;

  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  @IsNotEmpty()
  teamId: string;

  @IsBoolean()
  @IsOptional()
  sendNotificationEmails?: boolean;
}
