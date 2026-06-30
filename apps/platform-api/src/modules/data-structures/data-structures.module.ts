import { Module } from '@nestjs/common';
import { DataStructuresService } from './data-structures.service';
import { DataStructuresController } from './data-structures.controller';

@Module({
  providers: [DataStructuresService],
  controllers: [DataStructuresController],
  exports: [DataStructuresService],
})
export class DataStructuresModule {}
