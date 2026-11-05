import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { bellMessage } from '../../modules/notifications/bell-message';
import { RealtimeEventEnvelope } from './realtime-events.types';
import { RealtimeStreamService } from './realtime-stream.service';

@Injectable()
export class RealtimeEventsService {
  private readonly logger = new Logger(RealtimeEventsService.name);

  constructor(
    private readonly stream: RealtimeStreamService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Realtime is on by default. The legacy KB_REALTIME_PHASE1=1 opt-in remains
   * recognised for backwards compatibility with older deploy configs, but the
   * single source of truth is now KB_REALTIME_DISABLE — set that to '1' to
   * revert to the polling fallback without redeploying.
   */
  private isEnabled() {
    if (process.env.KB_REALTIME_DISABLE === '1') return false;
    return true;
  }

  async publish(input: Omit<RealtimeEventEnvelope, 'eventId' | 'traceId' | 'emittedAt' | 'feature'>) {
    if (!this.isEnabled()) return;

    const event: RealtimeEventEnvelope = {
      eventId: randomUUID(),
      traceId: randomUUID(),
      emittedAt: new Date().toISOString(),
      feature: 'realtime_phase1',
      ...input,
    };

    // Store before the push so a client that re-reads on the push always finds the row.
    await this.storeBellNotifications(event);
    this.stream.publish(event);
  }

  /** One row per recipient (never the actor), online or not; eventId makes a repeat a no-op. */
  private async storeBellNotifications(event: RealtimeEventEnvelope) {
    const msg = bellMessage(event);
    const users = (event.userIds ?? []).filter((id) => id && id !== event.actorUserId);
    if (!msg || !users.length) return;
    try {
      const { count } = await this.prisma.notification.createMany({
        data: users.map((userId) => ({ ...msg, userId, dedupeKey: event.eventId })),
        skipDuplicates: true,
      });
      this.logger.log(`Bell notification "${msg.title}" stored for ${count} user(s) (event ${event.eventId})`);
    } catch (err: any) {
      this.logger.error(`Bell notification store failed (event ${event.eventId}): ${err?.message ?? err}`);
    }
  }
}
