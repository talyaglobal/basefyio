import { IsNotEmpty, IsString, Matches } from 'class-validator';

/** Turning two-factor authentication off re-authenticates with both factors. */
export class DisableMfaDto {
  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @Matches(/^\d{6,8}$/, { message: 'code must be the 6 to 8 digit code from your authenticator' })
  code!: string;
}
