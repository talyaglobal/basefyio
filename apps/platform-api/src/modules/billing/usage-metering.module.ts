import { Global, Module } from '@nestjs/common';
import { MauTracker } from './mau-tracker.service';

/**
 * Global so the API-key guard and the project sign-in path, which live in many
 * modules, can count monthly active users without importing billing.
 */
@Global()
@Module({
  providers: [MauTracker],
  exports: [MauTracker],
})
export class UsageMeteringModule {}
