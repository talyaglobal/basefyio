import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PostgresJsonbProvider } from './storage/postgres-jsonb.provider';
import { StructureItemsService } from './structure-items.service';
import { StructureItemsController } from './structure-items.controller';

@Module({
  imports: [PrismaModule],
  providers: [PostgresJsonbProvider, StructureItemsService],
  controllers: [StructureItemsController],
})
export class StructureItemsModule {}
