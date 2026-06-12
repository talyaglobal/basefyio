import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { PolicyCompilerService } from './policy-compiler.service';
import { ItemPolicyGuard } from './item-policy.guard';
import { ItemFilesController } from './item-files.controller';
import { ItemFilesService } from './item-files.service';

@Module({
  imports: [ConfigModule],
  controllers: [ItemsController, ItemFilesController],
  providers: [ItemsService, PolicyCompilerService, ItemPolicyGuard, Reflector, ItemFilesService],
  exports: [ItemsService, PolicyCompilerService],
})
export class ItemsModule {}
