/**
 * Public data realtime — change events for app clients.
 *
 * Model: per-table/collection OPT-IN (RealtimeBinding). Nothing broadcasts
 * unless the developer enables the entity. Events are produced at the API
 * layer (REST v1, dashboard table editor, collections) — not from the write-
 * ahead log — so writes made through the platform broadcast instantly; raw SQL
 * writes do not.
 *
 * Transport is SSE over the existing infra (Traefik flushInterval already
 * tuned). Subscribers authenticate through ApiKeyGuard: the anon key may travel
 * in the query string because EventSource cannot set headers; a signed-in
 * user's token may come as a Bearer header or `?access_token=`.
 *
 * Delivery runs through RealtimeFanoutService so several API instances serve
 * one project, and through RealtimePolicyService so a table with row-level
 * security reaches each subscriber only with the rows that subscriber may read.
 * A table without RLS is delivered exactly as before to every subscriber.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeFanoutService } from './realtime-fanout.service';
import { RealtimePolicyService, policyGroupOf } from './realtime-policy.service';
import { RealtimePresenceService } from './realtime-presence.service';
import { RealtimeReplayService } from './realtime-replay.service';
import { parseSqlWrite } from './sql-write-events';
import type {
  DataChangeEvent,
  DataChangeType,
  FanoutMessage,
  RealtimeKind,
  SubscriberRole,
} from './realtime-data.types';

export type { DataChangeEvent, DataChangeType, RealtimeKind } from './realtime-data.types';

interface PendingFrame {
  eventName: string;
  data: unknown;
}

export interface Subscriber {
  id: string;
  projectId: string;
  /** 'table:orders', 'collection:posts', 'broadcast:room-1', or '*' */
  channels: Set<string>;
  res: Response;
  /** Postgres role the subscriber is evaluated as (from ApiKeyGuard). */
  role: SubscriberRole;
  jwtClaims?: Record<string, unknown>;
  /** Subscribers with the same group share one policy verdict per event. */
  policyGroup: string;
  presenceKey?: string;
  presenceMeta?: Record<string, unknown>;
  /** True while missed events are being replayed; live frames wait in `pending`. */
  replaying?: boolean;
  pending?: PendingFrame[];
  /** Ids written during the replay, so a live copy of the same event is not sent twice. */
  replayedIds?: Set<string>;
}

export interface SubscribeOptions {
  role?: SubscriberRole;
  jwtClaims?: Record<string, unknown>;
  presenceKey?: string;
  presenceMeta?: Record<string, unknown>;
  /** The id of the last event the client saw (SSE Last-Event-ID): replay what came after it. */
  lastEventId?: string;
  /** Requested data channels that are not enabled; reported in `ready` and as a `warning` frame. */
  inactive?: string[];
}

const BINDING_CACHE_TTL_MS = 30_000;

/** Frames that carry an event id, written as the SSE `id:` field so a client can resume after them. */
const RESUMABLE_FRAMES = new Set(['data_change', 'broadcast']);

@Injectable()
export class RealtimeDataService {
  private readonly logger = new Logger(RealtimeDataService.name);
  private readonly subscribers = new Map<string, Subscriber>();
  /** projectId → enabled 'kind:entity' set, with fetch timestamp. */
  private readonly bindingCache = new Map<string, { set: Set<string>; at: number }>();
  /** projectId → tail of the ordered write queue for data changes. */
  private readonly writeTail = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fanout: RealtimeFanoutService,
    private readonly policy: RealtimePolicyService,
    private readonly presence: RealtimePresenceService,
    @Optional() private readonly replay?: RealtimeReplayService,
  ) {
    this.fanout.setLocalDeliverer((msg) => this.deliverLocal(msg));
    if (this.replay) {
      const replay = this.replay;
      this.fanout.setRecorder?.((msg) => replay.record(msg));
    }
  }

  // ── Subscriptions ────────────────────────────────────────

  subscribe(projectId: string, channels: string[], res: Response, opts: SubscribeOptions = {}): string {
    const id = randomUUID();
    const normalized = new Set(
      channels.length === 0 ? ['*'] : channels.map((c) => c.trim()).filter(Boolean),
    );
    const role: SubscriberRole = opts.role ?? 'anon';
    const sub: Subscriber = {
      id,
      projectId,
      channels: normalized,
      res,
      role,
      jwtClaims: opts.jwtClaims,
      policyGroup: policyGroupOf(role, opts.jwtClaims),
      presenceKey: opts.presenceKey,
      presenceMeta: opts.presenceMeta,
    };
    const replayFrom = opts.lastEventId && this.replay?.enabled() ? opts.lastEventId : undefined;
    if (replayFrom) {
      sub.replaying = true;
      sub.pending = [];
      sub.replayedIds = new Set();
    }
    this.subscribers.set(id, sub);
    this.fanout.onLocalSubscriberAdded(projectId);
    this.write(res, 'ready', {
      subscriptionId: id,
      channels: [...normalized],
      role,
      presence: opts.presenceKey,
      ...(opts.inactive?.length ? { inactive: opts.inactive } : {}),
      ...(replayFrom ? { resumedAfter: replayFrom } : {}),
    });
    if (opts.inactive?.length) {
      this.write(res, 'warning', {
        code: 'channel_not_enabled',
        channels: opts.inactive,
        message:
          `Realtime is not enabled for ${opts.inactive.join(', ')} (or it does not exist). ` +
          'Enable it on the Realtime page of the dashboard or with PUT /api/rest/v1/realtime/bindings; ' +
          'this subscription starts receiving its changes as soon as it is enabled.',
      });
    }
    if (replayFrom) {
      void this.replayMissed(sub, replayFrom)
        .catch((err) => this.logger.warn(`replay failed: ${err?.message}`))
        .finally(() => this.finishReplay(sub));
    }
    if (opts.presenceKey) {
      void this.presence
        .join({
          id,
          projectId,
          channels: [...normalized],
          presenceKey: opts.presenceKey,
          presenceMeta: opts.presenceMeta,
        })
        .catch((err) => this.logger.warn(`presence join failed: ${err?.message}`));
    }
    return id;
  }

  unsubscribe(clientId: string): void {
    this.dropSubscriber(clientId);
  }

  heartbeat(clientId: string): void {
    const sub = this.subscribers.get(clientId);
    if (!sub) return;
    try {
      this.write(sub.res, 'ping', { t: Date.now() });
    } catch {
      this.dropSubscriber(clientId);
      return;
    }
    if (sub.presenceKey) {
      void this.presence.heartbeat(clientId).catch(() => undefined);
    }
  }

  /** Local subscriber count for a project — this instance only. */
  hasSubscribers(projectId: string): boolean {
    for (const sub of this.subscribers.values()) {
      if (sub.projectId === projectId) return true;
    }
    return false;
  }

  /** Whether any instance has a subscriber for the project. */
  hasAnySubscribers(projectId: string): Promise<boolean> {
    if (this.hasSubscribers(projectId)) return Promise.resolve(true);
    return this.fanout.hasAnySubscribers(projectId);
  }

  getSubscriber(clientId: string): Subscriber | undefined {
    return this.subscribers.get(clientId);
  }

  private dropSubscriber(clientId: string): void {
    const sub = this.subscribers.get(clientId);
    if (!sub) return;
    this.subscribers.delete(clientId);
    this.fanout.onLocalSubscriberRemoved(sub.projectId);
    // Keep recording for a while: the subscriber that just dropped may be
    // reconnecting and will ask for what it missed.
    if (!this.hasSubscribers(sub.projectId)) this.replay?.markWarm(sub.projectId);
    if (sub.presenceKey) {
      void this.presence.leave(clientId).catch(() => undefined);
    }
  }

  /** Subscribers of a project connected to this instance (status pages). */
  localSubscriberCount(projectId: string): number {
    let n = 0;
    for (const sub of this.subscribers.values()) if (sub.projectId === projectId) n++;
    return n;
  }

  // ── Replay after a reconnect ─────────────────────────────

  private subscriberWants(sub: Subscriber, kind: FanoutMessage['kind'], channel: string): boolean {
    return sub.channels.has(channel) || (kind === 'data_change' && sub.channels.has('*'));
  }

  /**
   * Write what the subscriber missed since `lastId`, each data change checked
   * against row-level security exactly as live delivery would. When the id is
   * no longer in the buffer, say so: the client should reload what it shows.
   */
  private async replayMissed(sub: Subscriber, lastId: string): Promise<void> {
    if (!this.replay) return;
    const { found, entries } = await this.replay.since(sub.projectId, lastId);
    if (!found) {
      this.writeDirect(sub, 'warning', {
        code: 'replay_gap',
        message:
          'Events from before this reconnect are no longer available, so some may have been missed. Reload the data you show.',
      });
      return;
    }
    for (const entry of entries) {
      if (!this.subscribers.has(sub.id)) return;
      if (!this.subscriberWants(sub, entry.kind, entry.channel)) continue;
      if (entry.kind === 'data_change') {
        const { deliverTo, event } = await this.policy.filterByPolicy(sub.projectId, entry.event as DataChangeEvent, [sub]);
        if (!deliverTo.includes(sub)) continue;
        this.writeDirect(sub, 'data_change', event);
      } else {
        this.writeDirect(sub, entry.kind, entry.event);
      }
      sub.replayedIds?.add(entry.id);
    }
  }

  /** Replay done: send what arrived live meanwhile, minus anything the replay already sent. */
  private finishReplay(sub: Subscriber): void {
    const pending = sub.pending ?? [];
    const seen = sub.replayedIds ?? new Set<string>();
    sub.replaying = false;
    sub.pending = undefined;
    sub.replayedIds = undefined;
    if (!this.subscribers.has(sub.id)) return;
    for (const frame of pending) {
      const id = (frame.data as { eventId?: unknown } | null)?.eventId;
      if (typeof id === 'string' && seen.has(id)) continue;
      this.writeDirect(sub, frame.eventName, frame.data);
    }
  }

  private writeDirect(sub: Subscriber, eventName: string, data: unknown): void {
    try {
      this.write(sub.res, eventName, data);
    } catch {
      this.dropSubscriber(sub.id);
    }
  }

  // ── Publishing (fire-and-forget from write paths) ────────

  publishChange(
    projectId: string,
    input: {
      type: DataChangeType;
      kind: RealtimeKind;
      entity: string;
      new?: Record<string, unknown> | null;
      old?: Record<string, unknown> | null;
    },
  ): void {
    // Never let realtime break a write path.
    void this.publishChangeAsync(projectId, input).catch((err) =>
      this.logger.warn(`publishChange failed: ${err?.message}`),
    );
  }

  /**
   * Events for a write run through `/sql/execute` with an API key — what the
   * SDK's `from(...).insert/update/delete/upsert` sends. Only the builder's own
   * statement shape is recognised (see sql-write-events.ts); the rows the
   * statement returned are the payloads. Fire-and-forget like publishChange.
   */
  publishSqlWrite(projectId: string, query: string, rows: Record<string, unknown>[] | undefined): number {
    const write = parseSqlWrite(query);
    if (!write || !rows?.length) return 0;
    for (const row of rows) {
      this.publishChange(projectId, {
        type: write.type,
        kind: 'table',
        entity: write.table,
        ...(write.type === 'DELETE' ? { old: row } : { new: row }),
      });
    }
    return rows.length;
  }

  private async publishChangeAsync(
    projectId: string,
    input: {
      type: DataChangeType;
      kind: RealtimeKind;
      entity: string;
      new?: Record<string, unknown> | null;
      old?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    if (!(await this.hasAnySubscribers(projectId)) && !(await this.replay?.isWarm(projectId))) return;
    if (!(await this.isEnabled(projectId, input.kind, input.entity))) return;

    let old = input.old ?? null;
    if (input.type === 'UPDATE' && !old && input.new) {
      old = await this.identifyingFields(projectId, input.kind, input.entity, input.new);
    }

    const event: DataChangeEvent = {
      eventId: randomUUID(),
      type: input.type,
      kind: input.kind,
      entity: input.entity,
      new: input.new ?? null,
      old,
      commitTimestamp: new Date().toISOString(),
    };

    this.fanout.publish({
      kind: 'data_change',
      projectId,
      channel: `${input.kind}:${input.entity}`,
      event,
    });
  }

  /**
   * The fields that identify a row — its primary key — taken from the new row
   * of an UPDATE, so `old` tells a subscriber which row changed (`{ id: 42 }`).
   * A collection document is identified by `id`. Null when the table has no
   * primary key or it cannot be read; the event is never held back for it.
   */
  private async identifyingFields(
    projectId: string,
    kind: RealtimeKind,
    entity: string,
    row: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (kind === 'collection') return row.id !== undefined ? { id: row.id } : null;
    try {
      const meta = await this.policy.tableMeta(projectId, 'public', entity);
      if (!meta || meta.pk.length === 0) return null;
      const out: Record<string, unknown> = {};
      for (const c of meta.pk) {
        if (!(c in row)) return null;
        out[c] = row[c];
      }
      return out;
    } catch {
      return null;
    }
  }

  // ── Delivery to this instance's subscribers ──────────────

  /**
   * Deliver one message to the local subscribers it is for. Broadcast and
   * presence frames go out at once; a data change first passes the policy
   * filter, and its write is queued behind the previous data change of the
   * project so a subscriber sees changes in publish order.
   */
  deliverLocal(msg: FanoutMessage): void {
    const candidates = this.match(msg);
    if (candidates.length === 0) return;

    if (msg.kind !== 'data_change') {
      this.writeAll(candidates, msg.kind, msg.event);
      return;
    }

    // The check starts now (so concurrent checks batch together); only the
    // write waits for its turn.
    const check = this.policy
      .filterByPolicy(msg.projectId, msg.event as DataChangeEvent, candidates)
      .catch((err) => {
        this.logger.warn(`policy filter failed: ${err?.message}`);
        return null;
      });
    const prev = this.writeTail.get(msg.projectId) ?? Promise.resolve();
    const next = prev
      .then(() => check)
      .then((result) => {
        if (!result) return;
        this.writeAll(result.deliverTo, 'data_change', result.event);
      })
      .catch((err) => this.logger.warn(`delivery failed: ${err?.message}`));
    this.writeTail.set(msg.projectId, next);
    void next.then(() => {
      if (this.writeTail.get(msg.projectId) === next) this.writeTail.delete(msg.projectId);
    });
  }

  private match(msg: FanoutMessage): Subscriber[] {
    const out: Subscriber[] = [];
    for (const sub of this.subscribers.values()) {
      if (sub.projectId !== msg.projectId) continue;
      if (msg.only && sub.id !== msg.only) continue;
      if (msg.exclude && sub.id === msg.exclude) continue;
      const matches =
        sub.channels.has(msg.channel) || (msg.kind === 'data_change' && sub.channels.has('*'));
      if (matches) out.push(sub);
    }
    return out;
  }

  private writeAll(subs: Subscriber[], eventName: string, data: unknown): void {
    for (const sub of subs) {
      // The subscriber may have gone while a check was pending.
      if (!this.subscribers.has(sub.id)) continue;
      if (sub.replaying) {
        sub.pending?.push({ eventName, data });
        continue;
      }
      try {
        this.write(sub.res, eventName, data);
      } catch {
        this.dropSubscriber(sub.id);
      }
    }
  }

  /**
   * One SSE frame. Data changes and broadcasts carry their event id as the
   * `id:` field, so a client can resume after the last one it saw.
   */
  private write(res: Response, eventName: string, data: unknown): void {
    const id = RESUMABLE_FRAMES.has(eventName) ? (data as { eventId?: unknown } | null)?.eventId : undefined;
    const idLine = typeof id === 'string' && id && !/[\r\n]/.test(id) ? `id: ${id}\n` : '';
    res.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ── Bindings (per-entity opt-in) ─────────────────────────

  async isEnabled(projectId: string, kind: RealtimeKind, entity: string): Promise<boolean> {
    const cached = this.bindingCache.get(projectId);
    if (cached && Date.now() - cached.at < BINDING_CACHE_TTL_MS) {
      return cached.set.has(`${kind}:${entity}`);
    }
    const rows = await this.prisma.realtimeBinding.findMany({
      where: { projectId },
      select: { kind: true, entity: true },
    });
    const set = new Set(rows.map((r) => `${r.kind}:${r.entity}`));
    this.bindingCache.set(projectId, { set, at: Date.now() });
    return set.has(`${kind}:${entity}`);
  }

  async listBindings(projectId: string) {
    const rows = await this.prisma.realtimeBinding.findMany({
      where: { projectId },
      orderBy: [{ kind: 'asc' }, { entity: 'asc' }],
      select: { kind: true, entity: true, createdAt: true },
    });
    return rows.map((r) => ({
      kind: r.kind as RealtimeKind,
      entity: r.entity,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async setBinding(
    projectId: string,
    kind: RealtimeKind,
    entity: string,
    enabled: boolean,
  ): Promise<{ kind: RealtimeKind; entity: string; enabled: boolean }> {
    if (enabled) {
      await this.prisma.realtimeBinding.upsert({
        where: { projectId_kind_entity: { projectId, kind, entity } },
        update: {},
        create: { projectId, kind, entity },
      });
    } else {
      await this.prisma.realtimeBinding.deleteMany({
        where: { projectId, kind, entity },
      });
    }
    this.bindingCache.delete(projectId);
    return { kind, entity, enabled };
  }
}
