import { Module } from '@nestjs/common';
import { DataImportController } from './data-import.controller';
import { DataImportService } from './data-import.service';
import { DataImportProcessor } from './data-import.processor';
import { ProjectActivityModule } from '../projects/project-activity.module';

@Module({
  imports: [ProjectActivityModule],
  controllers: [DataImportController],
  providers: [DataImportService, DataImportProcessor],
  exports: [DataImportService],
})
export class DataImportModule {}
