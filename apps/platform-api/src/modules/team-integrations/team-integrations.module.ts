import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TeamIntegrationsController } from './team-integrations.controller';
import { TeamIntegrationsService } from './team-integrations.service';

@Module({
  imports: [HttpModule],
  controllers: [TeamIntegrationsController],
  providers: [TeamIntegrationsService],
  exports: [TeamIntegrationsService],
})
export class TeamIntegrationsModule {}
