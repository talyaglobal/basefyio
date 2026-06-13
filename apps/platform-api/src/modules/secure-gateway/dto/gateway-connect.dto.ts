import { IsNotEmpty, IsString } from 'class-validator';

export class GatewayConnectDto {
  @IsString()
  @IsNotEmpty()
  certId: string;
}
