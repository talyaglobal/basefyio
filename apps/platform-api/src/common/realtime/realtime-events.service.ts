import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RealtimeEventEnvelope } from './realtime-events.types';
import { RealtimeStreamService } from './realtime-stream.service';

@Injectable()
export class RealtimeEventsService {
  constructor(private readonly stream: RealtimeStreamService) {}

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

    this.stream.publish(event);
  }
}
