import { Module } from '@nestjs/common';
import { MigrationArchivesService } from './migration-archives.service';
import { MigrationArchivesController } from './migration-archives.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MigrationArchivesService],
  controllers: [MigrationArchivesController],
  exports: [MigrationArchivesService],
})
export class MigrationArchivesModule {}
