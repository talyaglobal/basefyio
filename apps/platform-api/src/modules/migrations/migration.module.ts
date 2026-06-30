import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectsModule } from '../projects/projects.module';
import { BlueprintModule } from '../blueprint/blueprint.module';
import { MigrationController } from './migration.controller';
import { MigrationService } from './migration.service';

@Module({
  imports: [PrismaModule, ProjectsModule, BlueprintModule],
  controllers: [MigrationController],
  providers: [MigrationService],
})
export class MigrationModule {}
