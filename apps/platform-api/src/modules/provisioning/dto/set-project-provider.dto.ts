import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SetProjectProviderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  provider: string;
}
