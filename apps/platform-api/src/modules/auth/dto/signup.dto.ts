import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

export class SignupDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @Matches(/[A-Z]/, { message: 'Password must include at least one uppercase letter' })
  @Matches(/[a-z]/, { message: 'Password must include at least one lowercase letter' })
  @Matches(/[0-9]/, { message: 'Password must include at least one number' })
  @Matches(/[!-/:-@[-`{-~]/, {
    message: 'Password must include at least one punctuation character',
  })
  password!: string;

  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsString()
  @IsOptional()
  planName?: string;
}
