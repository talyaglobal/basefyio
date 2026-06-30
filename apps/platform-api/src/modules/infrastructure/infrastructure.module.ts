import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { InfrastructureService } from './infrastructure.service';

@Module({
  imports: [PrismaModule],
  providers: [InfrastructureService],
  exports: [InfrastructureService],
})
export class InfrastructureModule {}
