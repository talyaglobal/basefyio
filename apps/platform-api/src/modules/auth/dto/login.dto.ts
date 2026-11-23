import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @IsOptional()
  captchaAnswer?: string;

  /** The code from the account's authenticator app, when it has one (#196). */
  @IsString()
  @IsOptional()
  @MaxLength(16)
  totp?: string;
}
