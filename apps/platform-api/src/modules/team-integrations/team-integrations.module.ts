import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TeamIntegrationsController } from './team-integrations.controller';
import { TeamIntegrationsService } from './team-integrations.service';
import { TeamsModule } from '../teams/teams.module';

@Module({
  imports: [HttpModule, TeamsModule],
  controllers: [TeamIntegrationsController],
  providers: [TeamIntegrationsService],
  exports: [TeamIntegrationsService],
})
export class TeamIntegrationsModule {}
