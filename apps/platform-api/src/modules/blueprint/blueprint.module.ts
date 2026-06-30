import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { BlueprintController } from './blueprint.controller';
import { BlueprintService } from './blueprint.service';

@Module({
  imports: [PrismaModule, ProjectsModule],
  controllers: [BlueprintController],
  providers: [BlueprintService],
  exports: [BlueprintService],
})
export class BlueprintModule {}
