import { Module } from '@nestjs/common';
import { MigrationsService } from './migrations.service';
import { MigrationsController } from './migrations.controller';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [MigrationsService],
  controllers: [MigrationsController],
  exports: [MigrationsService],
})
export class MigrationsModule {}
