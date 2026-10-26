import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdmissionService } from './admission.service';
import { AdmissionInterceptor } from './admission.interceptor';

/**
 * Admission control for the whole API: a global interceptor (runs after the
 * guards) backed by one service. Global so the console and the metrics
 * exporter can read the gate statistics without importing anything.
 */
@Global()
@Module({
  providers: [AdmissionService, { provide: APP_INTERCEPTOR, useClass: AdmissionInterceptor }],
  exports: [AdmissionService],
})
export class AdmissionModule {}
