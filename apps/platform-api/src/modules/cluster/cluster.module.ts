import { Global, Module } from '@nestjs/common';
import { CronLeaderService } from './cron-leader.service';

/**
 * What the API needs to know about its siblings.
 *
 * A single container needs none of this: every scheduled job simply runs where
 * Nest registered it. The moment a second replica starts, each job would run
 * twice — two nightly backups, two WAL shipments racing to delete the same
 * segment, two recurring-charge runs. This module elects one process to own the
 * schedule and pauses the jobs everywhere else.
 *
 * Global because the health endpoint and the metrics exporter report the
 * elected role, and neither has a reason to import a cluster module.
 */
@Global()
@Module({
  providers: [CronLeaderService],
  exports: [CronLeaderService],
})
export class ClusterModule {}
