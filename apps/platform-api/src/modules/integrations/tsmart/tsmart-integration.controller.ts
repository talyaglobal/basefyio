import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { TsmartIntegrationGuard } from './tsmart-integration.guard';
import { TsmartIntegrationService, TsmartProjectList } from './tsmart-integration.service';

/**
 * Read-only feed for tsmart.ai: every basefyio project with its team, owner
 * address and current usage, so tsmart can bill per project. Polled hourly.
 *
 * Reachable only through TsmartIntegrationGuard (bearer token whose sha256 is
 * in TSMART_INTEGRATION_TOKEN_SHA256). No @SkipThrottle: the global IP rate
 * limit still applies. See docs/integrations/tsmart.md.
 */
@Controller('integrations/tsmart')
@UseGuards(TsmartIntegrationGuard)
export class TsmartIntegrationController {
  constructor(private readonly service: TsmartIntegrationService) {}

  @Get('projects')
  @Header('Cache-Control', 'no-store')
  listProjects(): Promise<TsmartProjectList> {
    return this.service.listProjects();
  }
}
