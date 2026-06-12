import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { RealtimeDataService, RealtimeKind } from './realtime-data.service';

const ENTITY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Public app-facing realtime stream (Supabase-style data change events). */
@Controller('realtime/v1')
export class RealtimeDataStreamController {
  constructor(
    private readonly realtime: RealtimeDataService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * SSE stream of data change events for one project.
   * EventSource cannot set headers, so the project API key arrives as
   * `?apikey=` — anon or service key both subscribe (broadcast model).
   * channels: comma list of `table:<name>` / `collection:<name>`, or omit for all.
   */
  @Get('stream')
  async stream(
    @Query('apikey') apikey: string | undefined,
    @Query('channels') channelsRaw: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const key = apikey?.trim();
    if (!key) throw new UnauthorizedException('Missing apikey query parameter');

    const project = await this.prisma.project.findFirst({
      where: { OR: [{ anonKey: key }, { serviceKey: key }], status: 'ACTIVE' },
      select: { id: true },
    });
    if (!project) throw new UnauthorizedException('Invalid API key');

    const channels = (channelsRaw || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
      .filter((c) => {
        const [kind, entity] = c.split(':');
        return (kind === 'table' || kind === 'collection') && !!entity && ENTITY_RE.test(entity);
      });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const clientId = this.realtime.subscribe(project.id, channels, res);
    const ping = setInterval(() => this.realtime.heartbeat(clientId), 25_000);

    req.on('close', () => {
      clearInterval(ping);
      this.realtime.unsubscribe(clientId);
      res.end();
    });
  }
}

/** Dashboard-facing binding management (which entities broadcast). */
@Controller('projects/:projectId/realtime-bindings')
@UseGuards(JwtAuthGuard)
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
  async list(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    await this.assertMember(projectId, user.sub);
    return this.realtime.listBindings(projectId);
  }

  @Put()
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
