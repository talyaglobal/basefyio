import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RealtimeEventEnvelope } from './realtime-events.types';

@Injectable()
export class RealtimeEventsService {
  private readonly logger = new Logger(RealtimeEventsService.name);

  private isEnabled() {
    return process.env.KB_REALTIME_PHASE1 === '1';
  }

  async publish(input: Omit<RealtimeEventEnvelope, 'eventId' | 'traceId' | 'emittedAt' | 'feature'>) {
    if (!this.isEnabled()) return;

    const edgeUrl = process.env.SUPABASE_REALTIME_EDGE_URL;
    const edgeSecret = process.env.SUPABASE_REALTIME_EDGE_SECRET || '';
    if (!edgeUrl) {
      this.logger.warn('SUPABASE_REALTIME_EDGE_URL is missing; realtime event skipped');
      return;
    }

    const event: RealtimeEventEnvelope = {
      eventId: randomUUID(),
      traceId: randomUUID(),
      emittedAt: new Date().toISOString(),
      feature: 'realtime_phase1',
      ...input,
    };

    try {
      await fetch(edgeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(edgeSecret ? { 'x-kb-edge-secret': edgeSecret } : {}),
        },
        body: JSON.stringify(event),
      });
    } catch (err: any) {
      this.logger.warn(`Failed to publish realtime event: ${err?.message || 'unknown error'}`);
    }
  }
}

