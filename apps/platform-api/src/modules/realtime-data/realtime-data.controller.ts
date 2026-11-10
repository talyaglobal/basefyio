import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Optional,
  Param,
  Patch,
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
import { RealtimePolicyService } from './realtime-policy.service';
import { RealtimePresenceService } from './realtime-presence.service';
import { RealtimeReplayService } from './realtime-replay.service';

const ENTITY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRESENCE_KEY_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const PRESENCE_META_MAX_BYTES = 1024;
/** A ping frame keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Splits `channels` — a comma list of `table:<name>`, `collection:<name>` or
 * `broadcast:<name>` — into the valid ones and the rest. A table named with
 * its schema (`table:public.orders`, `collection:nosql.posts`) is accepted as
 * the plain name, since that is the only schema realtime serves.
 */
export function classifyChannels(raw: string | undefined): { channels: string[]; invalid: string[] } {
  const channels: string[] = [];
  const invalid: string[] = [];
  for (const item of (raw || '').split(',').map((c) => c.trim()).filter(Boolean)) {
    const i = item.indexOf(':');
    const kind = i > 0 ? item.slice(0, i) : '';
    let entity = i > 0 ? item.slice(i + 1) : '';
    if (kind === 'table') entity = entity.replace(/^public\./, '');
    if (kind === 'collection') entity = entity.replace(/^nosql\./, '');
    const ok =
      ((kind === 'table' || kind === 'collection') && ENTITY_RE.test(entity)) ||
      (kind === 'broadcast' && BROADCAST_CHANNEL_RE.test(entity));
    if (ok) {
      const channel = `${kind}:${entity}`;
      if (!channels.includes(channel)) channels.push(channel);
    } else {
      invalid.push(item.slice(0, 140));
    }
  }
  return { channels, invalid };
}

/** The valid channels of a `channels` list (see classifyChannels). */
export function parseChannels(raw: string | undefined): string[] {
  return classifyChannels(raw).channels;
}

/**
 * The stream's `channels`, or a 400 naming what is wrong. An unknown channel
 * used to be dropped silently, and a list left empty that way meant "every
 * table" — the opposite of what the client asked for.
 */
export function requireValidChannels(raw: string | undefined): string[] {
  const { channels, invalid } = classifyChannels(raw);
  if (invalid.length > 0) {
    throw new BadRequestException(
      `Unknown channel${invalid.length > 1 ? 's' : ''} ${invalid.map((c) => `"${c}"`).join(', ')}. ` +
        'Use table:<name>, collection:<name> or broadcast:<name>; table and collection names are letters, digits and underscores.',
    );
  }
  return channels;
}

const LAST_EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The id of the last event a reconnecting client saw: `Last-Event-ID` header or `last_event_id` query. */
export function lastEventIdOf(req: Request): string | undefined {
  const header = req.headers?.['last-event-id'];
  const query = (req.query as Record<string, unknown> | undefined)?.last_event_id;
  const raw = (Array.isArray(header) ? header[0] : header) ?? (typeof query === 'string' ? query : undefined);
  const value = typeof raw === 'string' ? raw.trim() : '';
  return LAST_EVENT_ID_RE.test(value) ? value : undefined;
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
   * `broadcast:<name>`, or omit for every enabled entity. Anything else is a
   * 400. A table or collection whose realtime is not enabled is accepted (it
   * starts delivering once enabled) and named in the `ready` frame and in a
   * `warning` frame; with `strict=true` it is a 404 instead.
   * presence: a member key (or `auto` for the user's id) to join each channel.
   * Last-Event-ID (header) or `last_event_id`: replay what came after it.
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

    const channels = requireValidChannels(channelsRaw);
    const presence = parsePresence(presenceRaw, presenceMetaRaw, payload, channels);
    const inactive = await this.inactiveChannels(payload.projectId, channels);
    const strict = (req.query as Record<string, unknown> | undefined)?.strict;
    if (inactive.length > 0 && (strict === 'true' || strict === '1')) {
      throw new NotFoundException(
        `Realtime is not enabled for ${inactive.join(', ')} (or it does not exist). Enable it on the Realtime page of the dashboard or with PUT /api/rest/v1/realtime/bindings.`,
      );
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const lastEventId = lastEventIdOf(req);
    const clientId = this.realtime.subscribe(payload.projectId, channels, res, {
      role: payload.dbRole,
      jwtClaims: payload.jwtClaims,
      presenceKey: presence?.key,
      presenceMeta: presence?.meta,
      ...(inactive.length ? { inactive } : {}),
      ...(lastEventId ? { lastEventId } : {}),
    });
    const ping = setInterval(() => this.realtime.heartbeat(clientId), HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(ping);
      this.realtime.unsubscribe(clientId);
      res.end();
    });
  }

  /** The requested table/collection channels whose realtime is not enabled. */
  private async inactiveChannels(projectId: string, channels: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const c of channels) {
      const i = c.indexOf(':');
      const kind = c.slice(0, i);
      if (kind !== 'table' && kind !== 'collection') continue;
      try {
        if (!(await this.realtime.isEnabled(projectId, kind, c.slice(i + 1)))) out.push(c);
      } catch {
        // Unknown is not "disabled": never refuse a stream for a failed lookup.
      }
    }
    return out;
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

function validateBindingInput(kind: unknown, entity: unknown): { kind: RealtimeKind; entity: string } {
  if (kind !== 'table' && kind !== 'collection') {
    throw new BadRequestException('kind must be "table" or "collection"');
  }
  if (typeof entity !== 'string' || !ENTITY_RE.test(entity)) {
    throw new BadRequestException('Invalid entity name');
  }
  return { kind, entity };
}

/** Dashboard-facing binding management (which entities broadcast), status and the live inspector. */
@Controller('projects/:projectId/realtime-bindings')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class RealtimeBindingsController {
  constructor(
    private readonly realtime: RealtimeDataService,
    private readonly prisma: PrismaService,
    @Optional() private readonly policy?: RealtimePolicyService,
    @Optional() private readonly broadcastService?: RealtimeBroadcastService,
    @Optional() private readonly presence?: RealtimePresenceService,
    @Optional() private readonly replay?: RealtimeReplayService,
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
    const { kind, entity } = validateBindingInput(body?.kind, body?.entity);
    return this.realtime.setBinding(projectId, kind, entity, body.enabled === true);
  }

  /**
   * One entity on or off — the same as PUT, addressed by path. Every change
   * touches one row, so two people editing different entities never undo each
   * other.
   */
  @Patch(':kind/:entity')
  @Scopes('realtime:write')
  async patchOne(
    @Param('projectId') projectId: string,
    @Param('kind') kind: string,
    @Param('entity') entity: string,
    @Body() body: { enabled: boolean },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertMember(projectId, user.sub);
    const valid = validateBindingInput(kind, entity);
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
    return this.realtime.setBinding(projectId, valid.kind, valid.entity, body.enabled);
  }

  /**
   * Several entities at once (the dashboard's "Enable all" / "Disable all").
   * Only the entities named change; the answer is the full list afterwards, so
   * the page shows what is really stored, other people's changes included.
   */
  @Post('bulk')
  @HttpCode(200)
  @Scopes('realtime:write')
  async bulk(
    @Param('projectId') projectId: string,
    @Body() body: { enabled: boolean; entities: Array<{ kind: RealtimeKind; entity: string }> },
    @CurrentUser() user: JwtPayload,
  ) {
    await this.assertMember(projectId, user.sub);
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
    if (!Array.isArray(body?.entities) || body.entities.length === 0 || body.entities.length > 500) {
      throw new BadRequestException('entities must be a non-empty array of at most 500 { kind, entity }');
    }
    const items = body.entities.map((e) => validateBindingInput(e?.kind, e?.entity));
    for (const { kind, entity } of items) {
      await this.realtime.setBinding(projectId, kind, entity, body.enabled);
    }
    return this.realtime.listBindings(projectId);
  }

  /** What limits apply to this project's realtime, and how filtering is configured. */
  @Get('status')
  @Scopes('realtime:read')
  async status(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    await this.assertMember(projectId, user.sub);
    return {
      connectionsOnThisServer: this.realtime.localSubscriberCount(projectId),
      rlsFilter: this.policy?.getMode() ?? 'all',
      heartbeatSeconds: HEARTBEAT_MS / 1000,
      replay: {
        windowSeconds: Math.floor((this.replay?.windowMs ?? 0) / 1000),
        maxEvents: this.replay?.maxEvents ?? 0,
      },
      presence: {
        ttlSeconds: this.presence?.ttlSeconds ?? 90,
        keyMaxLength: 128,
        metaMaxBytes: PRESENCE_META_MAX_BYTES,
      },
      broadcast: this.broadcastService?.limits() ?? null,
      // Writes that produce events, and the ones that do not.
      sources: {
        events: ['REST API', 'SDK from()/insert/update/delete/upsert', 'dashboard table editor', 'collections'],
        silent: ['SQL editor', 'raw SQL from outside the platform', 'database triggers and functions'],
      },
    };
  }

  /**
   * The dashboard's live inspector: the project's change events, broadcasts
   * and presence as they happen, read as the service role (a team member sees
   * every row, as in the table editor). `channels` as for the public stream;
   * omitted = every enabled table and collection.
   */
  @Get('inspect')
  @Scopes('realtime:read')
  async inspect(
    @Param('projectId') projectId: string,
    @Query('channels') channelsRaw: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.assertMember(projectId, user.sub);
    const channels = requireValidChannels(channelsRaw);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const clientId = this.realtime.subscribe(projectId, channels, res, { role: 'service_role' });
    const ping = setInterval(() => this.realtime.heartbeat(clientId), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(ping);
      this.realtime.unsubscribe(clientId);
      res.end();
    });
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
    const { kind, entity } = validateBindingInput(body?.kind, body?.entity);
    return this.realtime.setBinding(p.projectId, kind, entity, body.enabled === true);
  }
}
