import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('realtime')
@UseGuards(JwtAuthGuard)
export class RealtimeController {
  constructor(
    private readonly stream: RealtimeStreamService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('stream')
  async streamEvents(
    @CurrentUser() user: JwtPayload,
    @Query('channels') channelsRaw: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const requested = (channelsRaw || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    // Authorisation. Without this, a client could ask for `team:other_team_id`
    // and start receiving another tenant's events. We accept:
    //   - `user:{uid}`     only if uid === own sub
    //   - `team:{teamId}`  only if the user is a TeamMember of that team
    //   - `project:{pid}`  only if the user is a member of the team that owns it
    // Anything else is silently dropped from the subscription. The user:{own}
    // channel is auto-added downstream so the client always receives its own
    // events regardless of what it requested.
    const authorized: string[] = [];
    const teamIds: string[] = [];
    const projectIds: string[] = [];
    for (const ch of requested) {
      const [kind, id] = ch.split(':');
      if (!id) continue;
      if (kind === 'user' && id === user.sub) authorized.push(ch);
      else if (kind === 'team') teamIds.push(id);
      else if (kind === 'project') projectIds.push(id);
    }
    if (teamIds.length > 0) {
      const memberships = await this.prisma.teamMember.findMany({
        where: { userId: user.sub, teamId: { in: teamIds } },
        select: { teamId: true },
      });
      const allowed = new Set(memberships.map((m) => m.teamId));
      for (const id of teamIds) {
        if (allowed.has(id)) authorized.push(`team:${id}`);
      }
    }
    if (projectIds.length > 0) {
      const projects = await this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, teamId: true },
      });
      const teamIdsForProjects = Array.from(new Set(projects.map((p) => p.teamId)));
      const memberships = await this.prisma.teamMember.findMany({
        where: { userId: user.sub, teamId: { in: teamIdsForProjects } },
        select: { teamId: true },
      });
      const allowedTeams = new Set(memberships.map((m) => m.teamId));
      for (const p of projects) {
        if (allowedTeams.has(p.teamId)) authorized.push(`project:${p.id}`);
      }
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // X-Accel-Buffering tells Nginx (and Cloudflare/CDN-style proxies that
    // honour it) to flush the SSE body byte-for-byte instead of buffering up
    // a few KB before forwarding. Without this header the client sees ~30s
    // chunks of silence followed by a burst, which makes the "live" feel
    // anything but. Same fix as our /data-imports/jobs/:id/events proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const clientId = this.stream.subscribe(user.sub, authorized, res);
    const ping = setInterval(() => this.stream.heartbeat(clientId), 25000);

    req.on('close', () => {
      clearInterval(ping);
      this.stream.unsubscribe(clientId);
      res.end();
    });
  }
}
