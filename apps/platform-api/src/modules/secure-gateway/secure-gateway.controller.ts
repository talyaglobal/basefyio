import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { SecureGatewayService } from './secure-gateway.service';
import { GatewayConnectDto } from './dto/gateway-connect.dto';
import { GatewayQueryDto } from './dto/gateway-query.dto';

@Controller('v1/projects/:projectId/gateway')
@UseGuards(JwtOrApiKeyGuard)
export class SecureGatewayController {
  constructor(private readonly gateway: SecureGatewayService) {}

  /**
   * Validates the certificate against OpenBao and returns the connection policy.
   * Response NEVER contains private key material.
   */
  @Post('connect')
  @HttpCode(HttpStatus.OK)
  async connect(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: GatewayConnectDto,
  ) {
    return this.gateway.connect(projectId, user.sub, dto.certId);
  }

  /**
   * Executes a query through the secure gateway with policy enforcement.
   * Requires GATEWAY_QUERY entitlement.
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  async query(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: GatewayQueryDto,
  ) {
    return this.gateway.executeQuery(projectId, user.sub, dto.certId, dto.sql, dto.params);
  }

  /** Returns the default connection policy for this project. */
  @Get('policy')
  getPolicy(@Param('projectId') projectId: string) {
    return this.gateway.getPolicy(projectId);
  }
}
