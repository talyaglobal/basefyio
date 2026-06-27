import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { QuickbooksService } from './quickbooks.service';
import { QuickbooksController } from './quickbooks.controller';
import { RootRoleGuard } from '../../common/guards/root-role.guard';

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [QuickbooksController],
  providers: [QuickbooksService, RootRoleGuard],
  exports: [QuickbooksService],
})
export class QuickbooksModule {}
