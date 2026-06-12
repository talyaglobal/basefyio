import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EntitlementService } from './entitlement.service';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [EntitlementService],
  exports: [EntitlementService],
})
export class EntitlementModule {}
