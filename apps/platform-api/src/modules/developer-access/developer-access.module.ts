import { Module } from '@nestjs/common';
import { DeveloperAccessService } from './developer-access.service';
import { DeveloperAccessController } from './developer-access.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { CertificateModule } from '../certificates/certificate.module';

@Module({
  imports: [PrismaModule, CertificateModule],
  providers: [DeveloperAccessService],
  controllers: [DeveloperAccessController],
  exports: [DeveloperAccessService],
})
export class DeveloperAccessModule {}
