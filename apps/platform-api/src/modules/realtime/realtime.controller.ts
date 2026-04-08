import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { RealtimeStreamService } from '../../common/realtime/realtime-stream.service';

@Controller('realtime')
@UseGuards(JwtAuthGuard)
export class RealtimeController {
  constructor(private readonly stream: RealtimeStreamService) {}

  @Get('stream')
  streamEvents(
    @CurrentUser() user: JwtPayload,
    @Query('channels') channelsRaw: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const channels = (channelsRaw || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const clientId = this.stream.subscribe(user.sub, channels, res);
    const ping = setInterval(() => this.stream.heartbeat(clientId), 25000);

    req.on('close', () => {
      clearInterval(ping);
      this.stream.unsubscribe(clientId);
      res.end();
    });
  }
}

