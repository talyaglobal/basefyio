import { Module } from '@nestjs/common';
import { SupabaseCompatController } from './supabase-compat.controller';
import { SupabaseCompatService } from './supabase-compat.service';
import { ItemsModule } from '../items/items.module';

@Module({
  imports: [ItemsModule],
  controllers: [SupabaseCompatController],
  providers: [SupabaseCompatService],
})
export class SupabaseCompatModule {}
