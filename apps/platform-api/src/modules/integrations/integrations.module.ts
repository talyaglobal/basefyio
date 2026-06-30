import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GitHubService } from './github.service';
import { VercelService } from './vercel.service';
import { ProjectActivityModule } from '../projects/project-activity.module';

@Module({
  imports: [HttpModule, ProjectActivityModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, GitHubService, VercelService],
})
export class IntegrationsModule {}
