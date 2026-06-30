import { IsEmail, IsNotEmpty } from 'class-validator';

export class ResendSignupOtpDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}
