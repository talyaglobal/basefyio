import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { AdvisorsController } from './advisors.controller';
import { AdvisorsService } from './advisors.service';

@Module({
  imports: [ProjectsModule],
  controllers: [AdvisorsController],
  providers: [AdvisorsService],
})
export class AdvisorsModule {}
