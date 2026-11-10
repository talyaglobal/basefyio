import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import type { FanoutMessage } from './realtime-data.types';

/** One recorded frame, as a reconnecting subscriber would have received it. */
export interface ReplayEntry {
  /** The event's own id — what the SSE `id:` field carried. */
  id: string;
  /** Epoch ms when it was recorded. */
  at: number;
  kind: 'data_change' | 'broadcast';
  channel: string;
  event: unknown;
}

export interface ReplayResult {
  /** False when the client's last id is no longer (or never was) in the buffer: events may be missing. */
  found: boolean;
  /** Entries after the client's last id, oldest first. */
  entries: ReplayEntry[];
}

const DEFAULT_WINDOW_SEC = 120;
const DEFAULT_MAX_EVENTS = 500;
const WARM_CACHE_MS = 5_000;

function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Short-lived memory of a project's recent events, so a subscriber whose
 * connection dropped can pick up where it left off.
 *
 * Every data change and broadcast frame carries its event id as the SSE `id:`
 * field. A client that reconnects with `Last-Event-ID` (EventSource does so on
 * its own; the SDK passes `last_event_id`) receives what it missed, provided
 * that is still within the window (`REALTIME_REPLAY_WINDOW_SEC`, default 120 s,
 * at most `REALTIME_REPLAY_MAX_EVENTS` per project). When the id is no longer
 * known, the client is told that events may be missing instead of being left to
 * assume it saw everything.
 *
 * The buffer is a Redis list per project, shared by every API instance; with
 * Redis unreachable each instance keeps its own. Events are only recorded for
 * projects that have — or very recently had — a subscriber ("warm"), so an idle
 * project costs nothing.
 */
@Injectable()
export class RealtimeReplayService {
  private readonly logger = new Logger(RealtimeReplayService.name);
  readonly windowMs: number;
  readonly maxEvents: number;
  /** projectId → recent entries, used while Redis is unavailable. */
  private readonly local = new Map<string, ReplayEntry[]>();
  /** projectId → time the project last had a local subscriber leave. */
  private readonly warmUntil = new Map<string, number>();
  /** projectId → cached answer from Redis. */
  private readonly remoteWarm = new Map<string, { warm: boolean; at: number }>();

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.windowMs = intOr(config.get<string>('REALTIME_REPLAY_WINDOW_SEC'), DEFAULT_WINDOW_SEC) * 1000;
    this.maxEvents = Math.max(1, intOr(config.get<string>('REALTIME_REPLAY_MAX_EVENTS'), DEFAULT_MAX_EVENTS));
  }

  enabled(): boolean {
    return this.windowMs > 0;
  }

  private key(projectId: string): string {
    return `rt:replay:${projectId}`;
  }

  private warmKey(projectId: string): string {
    return `rt:warm:${projectId}`;
  }

  private redisUp(): boolean {
    try {
      return this.redis.isReady();
    } catch {
      return false;
    }
  }

  /** Remember a message that subscribers may need again. Never throws. */
  record(msg: FanoutMessage): void {
    if (!this.enabled()) return;
    if (msg.only) return; // a frame meant for one subscriber is nobody else's history
    if (msg.kind !== 'data_change' && msg.kind !== 'broadcast') return;
    const id = (msg.event as { eventId?: unknown } | null)?.eventId;
    if (typeof id !== 'string' || !id) return;
    const entry: ReplayEntry = { id, at: Date.now(), kind: msg.kind, channel: msg.channel, event: msg.event };

    this.pushLocal(msg.projectId, entry);
    if (!this.redisUp()) return;
    const client = this.redis.getClient();
    const key = this.key(msg.projectId);
    client
      .multi()
      .rpush(key, JSON.stringify(entry))
      .ltrim(key, -this.maxEvents, -1)
      .pexpire(key, this.windowMs)
      .exec()
      .catch((err: any) => this.logger.debug(`replay record failed: ${err?.message}`));
  }

  private pushLocal(projectId: string, entry: ReplayEntry): void {
    const list = this.local.get(projectId) ?? [];
    list.push(entry);
    const cutoff = Date.now() - this.windowMs;
    while (list.length > this.maxEvents || (list.length && list[0].at < cutoff)) list.shift();
    this.local.set(projectId, list);
  }

  /** The entries after `lastId`, oldest first, within the window. */
  async since(projectId: string, lastId: string): Promise<ReplayResult> {
    if (!this.enabled()) return { found: false, entries: [] };
    let all: ReplayEntry[] | null = null;
    if (this.redisUp()) {
      try {
        const raw = await this.redis.getClient().lrange(this.key(projectId), 0, -1);
        all = raw
          .map((r) => {
            try {
              return JSON.parse(r) as ReplayEntry;
            } catch {
              return null;
            }
          })
          .filter((e): e is ReplayEntry => !!e);
      } catch (err: any) {
        this.logger.debug(`replay read failed: ${err?.message}`);
      }
    }
    all ??= this.local.get(projectId) ?? [];
    const cutoff = Date.now() - this.windowMs;
    const fresh = all.filter((e) => e.at >= cutoff);
    const at = fresh.findIndex((e) => e.id === lastId);
    if (at === -1) return { found: false, entries: [] };
    return { found: true, entries: fresh.slice(at + 1) };
  }

  /** A project's last local subscriber left: keep recording for the window. */
  markWarm(projectId: string): void {
    if (!this.enabled()) return;
    this.warmUntil.set(projectId, Date.now() + this.windowMs);
    if (!this.redisUp()) return;
    this.redis
      .getClient()
      .set(this.warmKey(projectId), '1', 'PX', this.windowMs)
      .catch((err: any) => this.logger.debug(`replay warm mark failed: ${err?.message}`));
  }

  /** Whether events should still be recorded for a project without subscribers. */
  async isWarm(projectId: string): Promise<boolean> {
    if (!this.enabled()) return false;
    const now = Date.now();
    const until = this.warmUntil.get(projectId);
    if (until !== undefined) {
      if (until > now) return true;
      this.warmUntil.delete(projectId);
    }
    if (!this.redisUp()) return false;
    const cached = this.remoteWarm.get(projectId);
    if (cached && now - cached.at < WARM_CACHE_MS) return cached.warm;
    try {
      const warm = (await this.redis.getClient().exists(this.warmKey(projectId))) > 0;
      this.remoteWarm.set(projectId, { warm, at: now });
      return warm;
    } catch {
      return false;
    }
  }
}
