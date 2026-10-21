import { Global, Module } from '@nestjs/common';
import { AuditSinkService } from './audit-sink.service';

/**
 * The audit forwarder, reachable from anywhere an audit row is written.
 *
 * Global for the same reason MetricsModule is: the two producers — the HTTP
 * audit interceptor registered on the app and the root-action capture in the
 * observability module — sit in different places, and the forwarder has to be
 * one instance with one queue.
 */
@Global()
@Module({
  providers: [AuditSinkService],
  exports: [AuditSinkService],
})
export class AuditSinkModule {}
