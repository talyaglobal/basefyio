import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyResetTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token!: string;
}
