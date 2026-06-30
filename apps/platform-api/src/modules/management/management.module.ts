import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ManagementController } from './management.controller';
import { ManagementService } from './management.service';

@Module({
  imports: [PrismaModule],
  controllers: [ManagementController],
  providers: [ManagementService],
})
export class ManagementModule {}
