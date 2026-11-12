import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { RealtimeEventEnvelope } from './realtime-events.types';

type StreamClient = {
  id: string;
  userId: string;
  channels: Set<string>;
  res: Response;
};

@Injectable()
export class RealtimeStreamService {
  private static clients = new Map<string, StreamClient>();

  subscribe(userId: string, channels: string[], res: Response) {
    const id = randomUUID();
    const normalized = channels
      .map((x) => x.trim())
      .filter(Boolean);
    const ownUserChannel = `user:${userId}`;
    if (!normalized.includes(ownUserChannel)) normalized.push(ownUserChannel);

    const client: StreamClient = {
      id,
      userId,
      channels: new Set(normalized),
      res,
    };
    RealtimeStreamService.clients.set(id, client);

    res.write(`event: ready\n`);
    res.write(`data: ${JSON.stringify({ clientId: id, channels: normalized })}\n\n`);

    return id;
  }

  unsubscribe(clientId: string) {
    RealtimeStreamService.clients.delete(clientId);
  }

  heartbeat(clientId: string) {
    const client = RealtimeStreamService.clients.get(clientId);
    if (!client) return;
    client.res.write(`event: ping\n`);
    client.res.write(`data: {"ok":true}\n\n`);
  }

  publish(event: RealtimeEventEnvelope) {
    const targets = new Set<string>();
    if (event.teamId) targets.add(`team:${event.teamId}`);
    if (event.projectId) targets.add(`project:${event.projectId}`);
    for (const uid of event.userIds || []) targets.add(`user:${uid}`);

    if (targets.size === 0) return;

    const payload = JSON.stringify(event);
    for (const [, client] of RealtimeStreamService.clients) {
      const matched = Array.from(targets).some((ch) => client.channels.has(ch));
      if (!matched) continue;
      client.res.write(`event: kb_event\n`);
      client.res.write(`data: ${payload}\n\n`);
    }
  }
}

