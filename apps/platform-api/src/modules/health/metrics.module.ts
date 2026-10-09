import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Counters anything may reach.
 *
 * Named for what it holds rather than for the discipline: an
 * ObservabilityModule already exists next door and serves the management
 * console, and two classes of that name in one app is a build error.
 *
 * Global because the things worth counting — a mail provider rejecting every
 * send, a public key refused on a route it may not reach — happen in modules
 * that have no reason to know about each other, and threading a provider
 * through each of them is how counting quietly stops happening.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
