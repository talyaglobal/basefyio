import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  @Matches(/[A-Z]/, { message: 'Password must include at least one uppercase letter' })
  @Matches(/[a-z]/, { message: 'Password must include at least one lowercase letter' })
  @Matches(/[0-9]/, { message: 'Password must include at least one number' })
  @Matches(/[!-/:-@[-`{-~]/, {
    message: 'Password must include at least one punctuation character',
  })
  newPassword: string;

  @IsOptional()
  @IsBoolean()
  allowIdentityEdit?: boolean;
}
