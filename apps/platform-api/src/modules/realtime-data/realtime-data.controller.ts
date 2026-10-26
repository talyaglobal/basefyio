import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { RealtimeDataService, RealtimeKind } from './realtime-data.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';
import { QueryAccessTokenGuard } from './query-access-token.guard';
import {
  BROADCAST_CHANNEL_RE,
  BroadcastInput,
  RealtimeBroadcastService,
} from './realtime-broadcast.service';

const ENTITY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRESENCE_KEY_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const PRESENCE_META_MAX_BYTES = 1024;

/**
 * `channels` is a comma list of `table:<name>`, `collection:<name>` or
 * `broadcast:<name>`. Anything else is dropped silently, as it always was.
 */
export function parseChannels(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .filter((c) => {
      const i = c.indexOf(':');
      if (i <= 0) return false;
      const kind = c.slice(0, i);
      const entity = c.slice(i + 1);
      if (kind === 'table' || kind === 'collection') return ENTITY_RE.test(entity);
      if (kind === 'broadcast') return BROADCAST_CHANNEL_RE.test(entity);
      return false;
    });
}

/**
 * `presence=<key>` makes the subscriber a member of each channel it subscribes
 * to; `presence=auto` uses the signed-in user's id. `presence_meta` is a small
 * JSON object shown to the other members.
 */
export function parsePresence(
  presenceRaw: string | undefined,
  metaRaw: string | undefined,
  payload: ApiKeyPayload,
  channels: string[],
): { key: string; meta?: Record<string, unknown> } | undefined {
  const raw = presenceRaw?.trim();
  if (!raw) return undefined;

  let key = raw;
  if (raw === 'auto') {
    const sub = payload.jwtClaims?.sub;
    if (typeof sub !== 'string' || !sub) {
      throw new BadRequestException('presence=auto requires a signed-in user (send the access token)');
    }
    key = sub;
  }
  if (!PRESENCE_KEY_RE.test(key)) {
    throw new BadRequestException('presence key must match ^[A-Za-z0-9_.:@-]{1,128}$');
  }
  if (channels.length === 0) {
    throw new BadRequestException('presence requires explicit channels');
  }

  let meta: Record<string, unknown> | undefined;
  if (metaRaw !== undefined && metaRaw !== '') {
    if (Buffer.byteLength(metaRaw, 'utf8') > PRESENCE_META_MAX_BYTES) {
      throw new BadRequestException(`presence_meta must be at most ${PRESENCE_META_MAX_BYTES} bytes`);
    }
    try {
      const parsed = JSON.parse(metaRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      meta = parsed as Record<string, unknown>;
    } catch {
      throw new BadRequestException('presence_meta must be a JSON object');
    }
  }
  return { key, meta };
}

// Express's answer behind the trusted proxies (`trust proxy` in main.ts); the
// left-most X-Forwarded-For hop is whatever the client chose to send.
function clientIpOf(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Public app-facing realtime stream: data changes, presence and broadcasts. */
@Controller('realtime/v1')
export class RealtimeDataStreamController {
  constructor(
    private readonly realtime: RealtimeDataService,
    private readonly broadcastService: RealtimeBroadcastService,
  ) {}

  /**
   * SSE stream for one project.
   *
   * The route sits behind ApiKeyGuard, the same guard as `rest/v1`. It accepts
   * the anon key from the `apikey` header or, because EventSource cannot set
   * headers, from `?apikey=`. A URL ends up in access logs, browser history and
   * Referer headers, so the secret service key is refused from the query string
   * (the guard's rule) — a server may still subscribe with it in the header.
   *
   * A signed-in user's access token may come as `Authorization: Bearer` or, for
   * EventSource, as `?access_token=` (QueryAccessTokenGuard copies it into the
   * header before ApiKeyGuard verifies it). The role and claims the guard
   * resolves are recorded on the subscriber: on a table with row-level
   * security, each subscriber receives only the rows its role may select; a
   * table without RLS is delivered to everyone, as before.
   *
   * channels: comma list of `table:<name>` / `collection:<name>` /
   * `broadcast:<name>`, or omit for every enabled entity.
   * presence: a member key (or `auto` for the user's id) to join each channel.
   */
  @Get('stream')
  @UseGuards(QueryAccessTokenGuard, ApiKeyGuard)
  async stream(
    @Query('channels') channelsRaw: string | undefined,
    @Query('presence') presenceRaw: string | undefined,
    @Query('presence_meta') presenceMetaRaw: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new UnauthorizedException('Invalid API key');

    const channels = parseChannels(channelsRaw);
    const presence = parsePresence(presenceRaw, presenceMetaRaw, payload, channels);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const clientId = this.realtime.subscribe(payload.projectId, channels, res, {
      role: payload.dbRole,
      jwtClaims: payload.jwtClaims,
      presenceKey: presence?.key,
      presenceMeta: presence?.meta,
    });
    const ping = setInterval(() => this.realtime.heartbeat(clientId), 25_000);

    req.on('close', () => {
      clearInterval(ping);
      this.realtime.unsubscribe(clientId);
      res.end();
    });
  }

  /**
   * Send a message to every subscriber of `broadcast:<channel>` without
   * touching the project database. Anon key (optionally with a signed-in
   * user's token) or service key; rate-limited and size-capped.
   */
  @Post('broadcast')
  @HttpCode(202)
  @UseGuards(ApiKeyGuard)
  async broadcast(@Body() body: BroadcastInput, @Req() req: Request) {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new UnauthorizedException('Invalid API key');
    return this.broadcastService.broadcastFromClient(payload, body ?? {}, clientIpOf(req));
  }
}

/** Dashboard-facing binding management (which entities broadcast). */
@Controller('projects/:projectId/realtime-bindings')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class RealtimeBindingsController {
  constructor(
    private readonly realtime: RealtimeDataService,
    private readonly prisma: PrismaService,
  ) {}

  private async assertMember(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { teamId: true },
    });
    if (!project) throw new ForbiddenException('Project not found');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this team');
  }

  @Get()
  @Scopes('realtime:read')
  async list(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    await this.assertMember(projectId, user.sub);
    return this.realtime.listBindings(projectId);
  }

  @Put()
  @Scopes('realtime:write')
  async set(
    @Param('projectId') projectId: string,
    @Body() body: { kind: RealtimeKind; entity: string; enabled: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertMember(projectId, user.sub);
    if (body.kind !== 'table' && body.kind !== 'collection') {
      throw new BadRequestException('kind must be "table" or "collection"');
    }
    if (!body.entity || !ENTITY_RE.test(body.entity)) {
      throw new BadRequestException('Invalid entity name');
    }
    return this.realtime.setBinding(projectId, body.kind, body.entity, body.enabled === true);
  }
}

/**
 * Programmatic realtime binding management for SDK clients and agents that only
 * hold a project API key (not a dashboard login). Reading is allowed with any
 * key; changing bindings requires the **service_role** key. The API key (sent as
 * the `apikey` header) identifies the project, so no project id is in the path.
 */
@Controller('rest/v1/realtime/bindings')
@UseGuards(ApiKeyGuard)
export class RealtimeApiController {
  constructor(private readonly realtime: RealtimeDataService) {}

  private payload(req: Request): ApiKeyPayload {
    const p = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!p) throw new UnauthorizedException('Invalid API key');
    return p;
  }

  @Get()
  async list(@Req() req: Request) {
    return this.realtime.listBindings(this.payload(req).projectId);
  }

  @Put()
  async set(
    @Body() body: { kind: RealtimeKind; entity: string; enabled: boolean },
    @Req() req: Request,
  ) {
    const p = this.payload(req);
    if (p.role !== 'service') {
      throw new ForbiddenException('A service_role API key is required to change realtime bindings');
    }
    if (body.kind !== 'table' && body.kind !== 'collection') {
      throw new BadRequestException('kind must be "table" or "collection"');
    }
    if (!body.entity || !ENTITY_RE.test(body.entity)) {
      throw new BadRequestException('Invalid entity name');
    }
    return this.realtime.setBinding(p.projectId, body.kind, body.entity, body.enabled === true);
  }
}
