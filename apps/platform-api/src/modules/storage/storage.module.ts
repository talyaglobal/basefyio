import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProjectActivityModule } from '../projects/project-activity.module';

@Module({
  imports: [PrismaModule, ProjectActivityModule],
  controllers: [StorageController],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
