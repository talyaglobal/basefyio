import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { RealtimeFanoutService } from './realtime-fanout.service';
import type { PresenceEvent, PresenceMember } from './realtime-data.types';

export interface PresenceSubscriber {
  id: string;
  projectId: string;
  channels: string[];
  presenceKey: string;
  presenceMeta?: Record<string, unknown>;
}

/** Separator between the presence key and the subscription id inside a member. */
const SEP = '\u0001';
const DEFAULT_TTL_SEC = 90;
const SWEEP_EVERY_MS = 30_000;
/** Members returned in a `sync`; larger rooms are truncated. */
export const PRESENCE_MAX_MEMBERS = 1000;

interface TrackedSub extends PresenceSubscriber {}

/**
 * Who is on a channel right now.
 *
 * A subscriber that passes a presence key is a member of each channel it
 * subscribes to; everyone on the channel (members or not) hears `join` and
 * `leave`, and the joiner alone receives a `sync` with the current list.
 * State lives in Redis so a room spans every API instance: a sorted set per
 * channel scored by last heartbeat, a hash for member metadata, both with a TTL
 * the heartbeat keeps refreshing, so an abandoned room disappears by itself.
 * Without Redis the same bookkeeping runs in memory, correct for one instance.
 */
@Injectable()
export class RealtimePresenceService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimePresenceService.name);
  private readonly ttlSec: number;
  private readonly tracked = new Map<string, TrackedSub>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  /** In-memory fallback: `${pid}|${channel}` → member → lastSeen. */
  private readonly localMembers = new Map<string, Map<string, number>>();
  private readonly localMeta = new Map<string, Map<string, string>>();

  constructor(
    private readonly redis: RedisService,
    private readonly fanout: RealtimeFanoutService,
    config: ConfigService,
  ) {
    const ttl = Number(config.get<string>('REALTIME_PRESENCE_TTL_SEC'));
    this.ttlSec = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SEC;
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  isTracked(subId: string): boolean {
    return this.tracked.has(subId);
  }

  async join(sub: PresenceSubscriber): Promise<void> {
    const channels = sub.channels.filter((c) => c !== '*');
    if (channels.length === 0) return;
    this.tracked.set(sub.id, { ...sub, channels });
    this.ensureSweeper();

    const now = Date.now();
    for (const channel of channels) {
      try {
        const before = await this.members(sub.projectId, channel, now);
        await this.add(sub.projectId, channel, sub.presenceKey, sub.id, sub.presenceMeta, now);
        const wasPresent = before.list.some((m) => m.key === sub.presenceKey);
        const list = before.list.filter((m) => m.key !== sub.presenceKey);
        list.push({ key: sub.presenceKey, meta: sub.presenceMeta, lastSeen: now });
        if (!wasPresent) {
          this.fanout.publish({
            kind: 'presence',
            projectId: sub.projectId,
            channel,
            event: this.event('join', channel, { key: sub.presenceKey, meta: sub.presenceMeta }),
          });
        }
        this.fanout.publishLocal({
          kind: 'presence',
          projectId: sub.projectId,
          channel,
          only: sub.id,
          event: this.event('sync', channel, { members: list, truncated: before.truncated || undefined }),
        });
      } catch (err: any) {
        this.logger.warn(`presence join failed on ${channel}: ${err?.message}`);
      }
    }
  }

  async heartbeat(subId: string): Promise<void> {
    const sub = this.tracked.get(subId);
    if (!sub) return;
    const now = Date.now();
    for (const channel of sub.channels) {
      try {
        await this.add(sub.projectId, channel, sub.presenceKey, sub.id, undefined, now);
      } catch (err: any) {
        this.logger.debug(`presence heartbeat failed on ${channel}: ${err?.message}`);
      }
    }
  }

  async leave(subId: string): Promise<void> {
    const sub = this.tracked.get(subId);
    if (!sub) return;
    this.tracked.delete(subId);
    for (const channel of sub.channels) {
      try {
        await this.remove(sub.projectId, channel, sub.presenceKey, sub.id);
        const still = await this.members(sub.projectId, channel, Date.now());
        if (!still.list.some((m) => m.key === sub.presenceKey)) {
          await this.dropMeta(sub.projectId, channel, sub.presenceKey);
          this.fanout.publish({
            kind: 'presence',
            projectId: sub.projectId,
            channel,
            event: this.event('leave', channel, { key: sub.presenceKey }),
          });
        }
      } catch (err: any) {
        this.logger.debug(`presence leave failed on ${channel}: ${err?.message}`);
      }
    }
  }

  /** Current members of a channel, stale rows purged. Public for the controller and tests. */
  async members(projectId: string, channel: string, now = Date.now()): Promise<{ list: PresenceMember[]; truncated: boolean }> {
    const cutoff = now - this.ttlSec * 1000;
    const byKey = new Map<string, number>();
    if (this.useRedis()) {
      const r = this.redis.getClient();
      const zkey = this.zkey(projectId, channel);
      await r.zremrangebyscore(zkey, '-inf', `(${cutoff}`);
      const rows = await r.zrange(zkey, 0, -1, 'WITHSCORES');
      for (let i = 0; i + 1 < rows.length; i += 2) {
        const key = rows[i].split(SEP)[0];
        const score = Number(rows[i + 1]);
        byKey.set(key, Math.max(byKey.get(key) ?? 0, score));
      }
      const meta = byKey.size ? await r.hgetall(this.mkey(projectId, channel)) : {};
      return this.toList(byKey, meta);
    }
    const members = this.localMembers.get(this.lkey(projectId, channel));
    if (members) {
      for (const [member, score] of members) {
        if (score < cutoff) {
          members.delete(member);
          continue;
        }
        const key = member.split(SEP)[0];
        byKey.set(key, Math.max(byKey.get(key) ?? 0, score));
      }
    }
    const meta = Object.fromEntries(this.localMeta.get(this.lkey(projectId, channel)) ?? []);
    return this.toList(byKey, meta);
  }

  /**
   * Members that stopped heartbeating (an instance that died without `close`)
   * are announced as gone. Every instance sweeps the channels it has members
   * on; a short lock keeps two instances from announcing the same departure.
   */
  async sweep(now = Date.now()): Promise<void> {
    const seen = new Set<string>();
    for (const sub of this.tracked.values()) {
      for (const channel of sub.channels) {
        const k = this.lkey(sub.projectId, channel);
        if (seen.has(k)) continue;
        seen.add(k);
        try {
          const stale = await this.staleKeys(sub.projectId, channel, now);
          if (stale.length === 0) continue;
          const live = await this.members(sub.projectId, channel, now);
          for (const key of stale) {
            if (live.list.some((m) => m.key === key)) continue;
            if (!(await this.claimLeave(sub.projectId, channel, key))) continue;
            await this.dropMeta(sub.projectId, channel, key);
            this.fanout.publish({
              kind: 'presence',
              projectId: sub.projectId,
              channel,
              event: this.event('leave', channel, { key }),
            });
          }
        } catch (err: any) {
          this.logger.debug(`presence sweep failed on ${channel}: ${err?.message}`);
        }
      }
    }
  }

  // ── Storage ──────────────────────────────────────────────

  private useRedis(): boolean {
    return this.fanout.isEnabled() && this.redis.isReady();
  }

  private zkey(pid: string, channel: string): string {
    return `rt:presence:${pid}:${channel}`;
  }

  private mkey(pid: string, channel: string): string {
    return `rt:presence-meta:${pid}:${channel}`;
  }

  private lkey(pid: string, channel: string): string {
    return `${pid}|${channel}`;
  }

  private async add(
    pid: string,
    channel: string,
    key: string,
    subId: string,
    meta: Record<string, unknown> | undefined,
    now: number,
  ): Promise<void> {
    const member = `${key}${SEP}${subId}`;
    if (this.useRedis()) {
      const r = this.redis.getClient();
      await r.zadd(this.zkey(pid, channel), now, member);
      if (meta !== undefined) await r.hset(this.mkey(pid, channel), key, JSON.stringify(meta));
      await r.expire(this.zkey(pid, channel), this.ttlSec);
      await r.expire(this.mkey(pid, channel), this.ttlSec);
      return;
    }
    const lk = this.lkey(pid, channel);
    let members = this.localMembers.get(lk);
    if (!members) this.localMembers.set(lk, (members = new Map()));
    members.set(member, now);
    if (meta !== undefined) {
      let metas = this.localMeta.get(lk);
      if (!metas) this.localMeta.set(lk, (metas = new Map()));
      metas.set(key, JSON.stringify(meta));
    }
  }

  private async remove(pid: string, channel: string, key: string, subId: string): Promise<void> {
    const member = `${key}${SEP}${subId}`;
    if (this.useRedis()) {
      await this.redis.getClient().zrem(this.zkey(pid, channel), member);
      return;
    }
    this.localMembers.get(this.lkey(pid, channel))?.delete(member);
  }

  private async dropMeta(pid: string, channel: string, key: string): Promise<void> {
    if (this.useRedis()) {
      await this.redis.getClient().hdel(this.mkey(pid, channel), key);
      return;
    }
    this.localMeta.get(this.lkey(pid, channel))?.delete(key);
  }

  /** Keys with at least one row older than the TTL, before those rows are purged. */
  private async staleKeys(pid: string, channel: string, now: number): Promise<string[]> {
    const cutoff = now - this.ttlSec * 1000;
    const keys = new Set<string>();
    if (this.useRedis()) {
      const rows = await this.redis.getClient().zrangebyscore(this.zkey(pid, channel), '-inf', `(${cutoff}`);
      for (const m of rows) keys.add(m.split(SEP)[0]);
      return [...keys];
    }
    for (const [member, score] of this.localMembers.get(this.lkey(pid, channel)) ?? []) {
      if (score < cutoff) keys.add(member.split(SEP)[0]);
    }
    return [...keys];
  }

  private async claimLeave(pid: string, channel: string, key: string): Promise<boolean> {
    if (!this.useRedis()) return true;
    const res = await this.redis.getClient().set(`rt:presence-left:${pid}:${channel}:${key}`, '1', 'EX', 60, 'NX');
    return res === 'OK';
  }

  private toList(byKey: Map<string, number>, meta: Record<string, string>): { list: PresenceMember[]; truncated: boolean } {
    const list: PresenceMember[] = [];
    for (const [key, lastSeen] of byKey) {
      if (list.length >= PRESENCE_MAX_MEMBERS) break;
      let parsed: Record<string, unknown> | undefined;
      if (meta[key]) {
        try {
          parsed = JSON.parse(meta[key]);
        } catch {
          parsed = undefined;
        }
      }
      list.push({ key, meta: parsed, lastSeen });
    }
    return { list, truncated: byKey.size > list.length };
  }

  private event(type: PresenceEvent['type'], channel: string, extra: Partial<PresenceEvent>): PresenceEvent {
    return { type, channel, at: new Date().toISOString(), ...extra };
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    (this.sweeper as any).unref?.();
  }
}
