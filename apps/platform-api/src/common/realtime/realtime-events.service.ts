import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RealtimeEventEnvelope } from './realtime-events.types';
import { RealtimeStreamService } from './realtime-stream.service';

@Injectable()
export class RealtimeEventsService {
  constructor(private readonly stream: RealtimeStreamService) {}

  private isEnabled() {
    return process.env.KB_REALTIME_PHASE1 === '1';
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

