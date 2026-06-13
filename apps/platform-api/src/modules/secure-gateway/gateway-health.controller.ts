import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { OpenBaoHealthService, OpenBaoHealthReport } from '../certificates/openbao-health.service';

/**
 * Read-only OpenBao health surface.
 * No mutations, no key access, no bundle reads.
 * Response never contains vault token, base URL, or credentials.
 */
@Controller('v1/secure-gateway/health')
@UseGuards(JwtOrApiKeyGuard)
export class GatewayHealthController {
  constructor(private readonly health: OpenBaoHealthService) {}

  @Get('openbao')
  async openbao(): Promise<OpenBaoHealthReport> {
    return this.health.check();
  }
}
