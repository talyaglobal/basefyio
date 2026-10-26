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

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeFanoutService } from './realtime-fanout.service';
import { RealtimePolicyService, policyGroupOf } from './realtime-policy.service';
import { RealtimePresenceService } from './realtime-presence.service';
import type {
  DataChangeEvent,
  DataChangeType,
  FanoutMessage,
  RealtimeKind,
  SubscriberRole,
} from './realtime-data.types';

export type { DataChangeEvent, DataChangeType, RealtimeKind } from './realtime-data.types';

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
}

export interface SubscribeOptions {
  role?: SubscriberRole;
  jwtClaims?: Record<string, unknown>;
  presenceKey?: string;
  presenceMeta?: Record<string, unknown>;
}

const BINDING_CACHE_TTL_MS = 30_000;

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
  ) {
    this.fanout.setLocalDeliverer((msg) => this.deliverLocal(msg));
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
    this.subscribers.set(id, sub);
    this.fanout.onLocalSubscriberAdded(projectId);
    this.write(res, 'ready', {
      subscriptionId: id,
      channels: [...normalized],
      role,
      presence: opts.presenceKey,
    });
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

  /**
   * On shutdown: tell every subscriber to reconnect and end its stream, so
   * the browser's EventSource comes back to a replica that is staying,
   * instead of hanging on a socket this process is about to close.
   */
  closeAllForDrain(): number {
    let n = 0;
    for (const [id, sub] of [...this.subscribers]) {
      try {
        this.write(sub.res, 'reconnect', { reason: 'draining' });
        sub.res.end();
      } catch {
        /* the socket may already be gone */
      }
      this.dropSubscriber(id);
      n++;
    }
    return n;
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
    if (sub.presenceKey) {
      void this.presence.leave(clientId).catch(() => undefined);
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
    if (!(await this.hasAnySubscribers(projectId))) return;
    if (!(await this.isEnabled(projectId, input.kind, input.entity))) return;

    const event: DataChangeEvent = {
      eventId: randomUUID(),
      type: input.type,
      kind: input.kind,
      entity: input.entity,
      new: input.new ?? null,
      old: input.old ?? null,
      commitTimestamp: new Date().toISOString(),
    };

    this.fanout.publish({
      kind: 'data_change',
      projectId,
      channel: `${input.kind}:${input.entity}`,
      event,
    });
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
      try {
        this.write(sub.res, eventName, data);
      } catch {
        this.dropSubscriber(sub.id);
      }
    }
  }

  private write(res: Response, eventName: string, data: unknown): void {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
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
