import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { StorageModule } from '../storage/storage.module';
import { MarketingAgencyController } from './marketing-agency.controller';
import { MarketingAgencyService } from './marketing-agency.service';
import { ClaudeProvider } from './providers/claude.provider';
import { ElevenLabsProvider } from './providers/elevenlabs.provider';
import { FalProvider } from './providers/fal.provider';
import { PubblerProvider } from './providers/pubbler.provider';

@Module({
  // StorageModule supplies the public bucket the ElevenLabs voiceover lands in —
  // Pubbler can only attach media it can fetch over HTTP.
  imports: [PrismaModule, StorageModule],
  controllers: [MarketingAgencyController],
  providers: [
    MarketingAgencyService,
    ClaudeProvider,
    FalProvider,
    ElevenLabsProvider,
    PubblerProvider,
    ManagementPermissionGuard,
  ],
})
export class MarketingAgencyModule {}
