import { Module } from '@nestjs/common';
import { MigrationAssessmentsService } from './migration-assessments.service';
import { MigrationAssessmentsController } from './migration-assessments.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MigrationAssessmentsService],
  controllers: [MigrationAssessmentsController],
  exports: [MigrationAssessmentsService],
})
export class MigrationAssessmentsModule {}
