import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { CodefyioService } from './codefyio.service';
import { CodefyioJwtService } from './codefyio-jwt.service';
import { CodefyioSessionGuard } from './codefyio-session.guard';
import { ADAPTER_VERSION, CODEFYIO_ACTIONS } from './codefyio.constants';
import { AdapterSessionClaims } from './codefyio.types';

/**
 * HTTP surface for the Codefyio IDE. Mounted at `/_codefyio` (excluded from the
 * global `/api` prefix in main.ts). CORS is restricted to CODEFYIO_ORIGIN.
 */
@Controller('_codefyio')
export class CodefyioController {
  constructor(
    private readonly service: CodefyioService,
    private readonly jwt: CodefyioJwtService,
    private readonly config: ConfigService,
  ) {}

  /** Restrict cross-origin access to the configured Codefyio origin only. */
  private cors(req: Request, res: Response) {
    const configured = this.config.get<string>('codefyio.origin');
    const origin = configured || (req.headers.origin as string) || '*';
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    // No embedding (manifest.embed = null): forbid framing except by Codefyio.
    res.header('Content-Security-Policy', `frame-ancestors ${configured || "'none'"}`);
  }

  private session(req: Request): AdapterSessionClaims {
    return (req as any).codefyioSession as AdapterSessionClaims;
  }

  private buildManifest() {
    const baseUrl =
      this.config.get<string>('publicApiUrl') || 'https://api.basefyio.com';
    return {
      schemaVersion: '1.0',
      id: 'basefyio',
      label: 'basefyio',
      category: 'database',
      summary:
        'Open-source Supabase/Firebase-alternative BaaS — Postgres database, auth, storage and REST/SQL, per project.',
      baseUrl,
      auth: { type: 'oauth2-token-exchange', scopes: ['read', 'write'] },
      capabilities: ['status', 'list', 'action', 'events'],
      endpoints: {
        health: '/_codefyio/health',
        manifest: '/_codefyio/manifest',
        exchange: '/_codefyio/auth/exchange',
        resources: '/_codefyio/resources',
        action: '/_codefyio/action',
        events: '/_codefyio/events',
      },
      actions: CODEFYIO_ACTIONS,
      embed: null,
    };
  }

  @Get('health')
  health(@Req() req: Request, @Res() res: Response) {
    this.cors(req, res);
    res.json({ status: 'ok', version: ADAPTER_VERSION });
  }

  @Get('manifest')
  manifest(@Req() req: Request, @Res() res: Response) {
    this.cors(req, res);
    res.json(this.buildManifest());
  }

  @Post('auth/exchange')
  async exchange(
    @Body() body: { codefyioToken?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.cors(req, res);
    const result = await this.service.exchange(body?.codefyioToken || '');
    res.json(result);
  }

  @Get('resources')
  @UseGuards(CodefyioSessionGuard)
  async resources(
    @Query('cursor') cursor: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.cors(req, res);
    res.json(await this.service.listResources(this.session(req), cursor));
  }

  @Post('action')
  @UseGuards(CodefyioSessionGuard)
  async action(
    @Body() body: { action: string; resourceId?: string; params?: unknown },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    this.cors(req, res);
    res.json(await this.service.executeAction(this.session(req), body));
  }

  @Get('events')
  @UseGuards(CodefyioSessionGuard)
  events(@Req() req: Request, @Res() res: Response) {
    this.cors(req, res);
    res.header('Content-Type', 'text/event-stream');
    res.header('Cache-Control', 'no-cache');
    res.header('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sub = this.service.eventStream(this.session(req)).subscribe((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    req.on('close', () => sub.unsubscribe());
  }
}
