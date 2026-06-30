/**
 * Public data realtime — Supabase-style change events for app clients.
 *
 * Model: per-table/collection OPT-IN (RealtimeBinding). Nothing broadcasts
 * unless the developer enables the entity, mirroring Supabase's
 * `supabase_realtime` publication. Events are produced at the API layer
 * (REST v1, dashboard table editor, collections) — not WAL — so writes made
 * through the platform broadcast instantly; raw SQL writes do not (v1).
 *
 * Transport is SSE over the existing infra (Traefik flushInterval already
 * tuned). Subscribers authenticate with a project API key in the query
 * string because EventSource cannot set headers.
 *
 * NOTE: change payloads bypass row-level security (same as Postgres logical
 * replication with REPLICA IDENTITY). Enabling realtime on a table is the
 * developer's explicit consent to broadcast its rows to key holders.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

export type DataChangeType = 'INSERT' | 'UPDATE' | 'DELETE';
export type RealtimeKind = 'table' | 'collection';

export interface DataChangeEvent {
  eventId: string;
  type: DataChangeType;
  kind: RealtimeKind;
  entity: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  commitTimestamp: string;
}

interface Subscriber {
  id: string;
  projectId: string;
  /** 'table:orders', 'collection:posts', or '*' */
  channels: Set<string>;
  res: Response;
}

const BINDING_CACHE_TTL_MS = 30_000;

@Injectable()
export class RealtimeDataService {
  private readonly logger = new Logger(RealtimeDataService.name);
  private readonly subscribers = new Map<string, Subscriber>();
  /** projectId → enabled 'kind:entity' set, with fetch timestamp. */
  private readonly bindingCache = new Map<string, { set: Set<string>; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  // ── Subscriptions ────────────────────────────────────────

  subscribe(projectId: string, channels: string[], res: Response): string {
    const id = randomUUID();
    const normalized = new Set(
      channels.length === 0 ? ['*'] : channels.map((c) => c.trim()).filter(Boolean),
    );
    this.subscribers.set(id, { id, projectId, channels: normalized, res });
    this.write(res, 'ready', { subscriptionId: id, channels: [...normalized] });
    return id;
  }

  unsubscribe(clientId: string): void {
    this.subscribers.delete(clientId);
  }

  heartbeat(clientId: string): void {
    const sub = this.subscribers.get(clientId);
    if (!sub) return;
    try {
      this.write(sub.res, 'ping', { t: Date.now() });
    } catch {
      this.subscribers.delete(clientId);
    }
  }

  /** Subscriber count for a project — lets publishers skip all work when idle. */
  hasSubscribers(projectId: string): boolean {
    for (const sub of this.subscribers.values()) {
      if (sub.projectId === projectId) return true;
    }
    return false;
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
    if (!this.hasSubscribers(projectId)) return;
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

    const channel = `${input.kind}:${input.entity}`;
    for (const sub of this.subscribers.values()) {
      if (sub.projectId !== projectId) continue;
      if (!sub.channels.has('*') && !sub.channels.has(channel)) continue;
      try {
        this.write(sub.res, 'data_change', event);
      } catch {
        this.subscribers.delete(sub.id);
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
