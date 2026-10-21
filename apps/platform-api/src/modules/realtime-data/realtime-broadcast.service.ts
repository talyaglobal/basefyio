import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { ApiKeyPayload } from '../../common/guards/api-key.guard';
import { RedisService } from '../redis/redis.service';
import { RealtimeFanoutService } from './realtime-fanout.service';
import type { BroadcastEvent } from './realtime-data.types';

/** A broadcast channel name as the client names it (the server prefixes `broadcast:`). */
export const BROADCAST_CHANNEL_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const BROADCAST_EVENT_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const FROM_MAX_LEN = 64;

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_RATE_PER_MIN = 600;
const DEFAULT_PROJECT_RATE_PER_MIN = 6000;

export interface BroadcastInput {
  channel?: unknown;
  event?: unknown;
  payload?: unknown;
  from?: unknown;
}

/**
 * Client-to-client messages that never touch a project database.
 *
 * A client holding the project's anon key (and optionally a signed-in user's
 * token) posts `{ channel, event, payload }`; every subscriber of
 * `broadcast:<channel>` on any instance receives it. Size and rate limits bound
 * what a public key can do with it; nothing is stored.
 */
@Injectable()
export class RealtimeBroadcastService {
  private readonly logger = new Logger(RealtimeBroadcastService.name);
  private readonly maxBytes: number;
  private readonly ratePerMin: number;
  private readonly projectRatePerMin: number;
  private readonly requireJwt: boolean;
  /** In-memory counters used only while Redis is unavailable. */
  private readonly localCounters = new Map<string, { n: number; resetAt: number }>();

  constructor(
    private readonly redis: RedisService,
    private readonly fanout: RealtimeFanoutService,
    config: ConfigService,
  ) {
    this.maxBytes = intOr(config.get<string>('REALTIME_BROADCAST_MAX_BYTES'), DEFAULT_MAX_BYTES);
    this.ratePerMin = intOr(config.get<string>('REALTIME_BROADCAST_RATE_PER_MIN'), DEFAULT_RATE_PER_MIN);
    this.projectRatePerMin = intOr(
      config.get<string>('REALTIME_BROADCAST_PROJECT_RATE_PER_MIN'),
      DEFAULT_PROJECT_RATE_PER_MIN,
    );
    this.requireJwt = config.get<string>('REALTIME_BROADCAST_REQUIRE_JWT') === '1';
  }

  async broadcastFromClient(
    payload: ApiKeyPayload,
    body: BroadcastInput,
    clientIp: string,
  ): Promise<{ ok: true; eventId: string }> {
    const channel = typeof body?.channel === 'string' ? body.channel.trim() : '';
    const eventName = typeof body?.event === 'string' ? body.event.trim() : '';
    if (!BROADCAST_CHANNEL_RE.test(channel)) {
      throw new BadRequestException('channel must match ^[A-Za-z0-9_.:-]{1,128}$');
    }
    if (!BROADCAST_EVENT_RE.test(eventName)) {
      throw new BadRequestException('event must match ^[A-Za-z0-9_.:-]{1,64}$');
    }
    let from: string | undefined;
    if (body?.from !== undefined && body?.from !== null) {
      if (typeof body.from !== 'string' || body.from.length === 0 || body.from.length > FROM_MAX_LEN) {
        throw new BadRequestException('from must be the subscription id of the sender');
      }
      from = body.from;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(body?.payload ?? null);
    } catch {
      throw new BadRequestException('payload must be JSON-serialisable');
    }
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new PayloadTooLargeException(`payload exceeds ${this.maxBytes} bytes`);
    }

    const isService = payload.role === 'service';
    const sub = typeof payload.jwtClaims?.sub === 'string' ? (payload.jwtClaims.sub as string) : undefined;
    if (this.requireJwt && !isService && !sub) {
      throw new ForbiddenException('Broadcasting requires a signed-in user on this deployment');
    }

    // Project-wide bucket first (0 disables broadcast for the deployment),
    // then the sender's own bucket; the service key is a server and skips it.
    if (!(await this.consume(`rt:bc:${payload.projectId}`, this.projectRatePerMin))) {
      throw tooMany('This project is sending too many broadcasts');
    }
    if (!isService) {
      const identity = sub ?? `ip:${clientIp || 'unknown'}`;
      if (!(await this.consume(`rt:bc:${payload.projectId}:${identity}`, this.ratePerMin))) {
        throw tooMany('Too many broadcasts from this sender');
      }
    }

    const event: BroadcastEvent = {
      eventId: randomUUID(),
      channel,
      event: eventName,
      payload: body?.payload ?? null,
      sender: { role: payload.dbRole, sub },
      sentAt: new Date().toISOString(),
    };
    this.fanout.publish({
      kind: 'broadcast',
      projectId: payload.projectId,
      channel: `broadcast:${channel}`,
      event,
      exclude: from,
    });
    return { ok: true, eventId: event.eventId };
  }

  /** Count one unit in a one-minute window; false once the window is over its limit. */
  private async consume(key: string, limit: number): Promise<boolean> {
    if (limit <= 0) return false;
    if (this.redis.isReady()) {
      try {
        const client = this.redis.getClient();
        const n = await client.incr(key);
        if (n === 1) await client.expire(key, 60);
        return n <= limit;
      } catch (err: any) {
        this.logger.debug(`rate counter failed, using local counter: ${err?.message}`);
      }
    }
    const now = Date.now();
    let c = this.localCounters.get(key);
    if (!c || c.resetAt <= now) {
      c = { n: 0, resetAt: now + 60_000 };
      this.localCounters.set(key, c);
      if (this.localCounters.size > 10_000) this.pruneLocal(now);
    }
    c.n += 1;
    return c.n <= limit;
  }

  private pruneLocal(now: number): void {
    for (const [k, c] of this.localCounters) if (c.resetAt <= now) this.localCounters.delete(k);
  }
}

function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function tooMany(message: string): HttpException {
  return new HttpException(
    { statusCode: HttpStatus.TOO_MANY_REQUESTS, message, error: 'Too Many Requests' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
