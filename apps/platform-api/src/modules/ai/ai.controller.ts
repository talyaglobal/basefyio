import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { assertProjectTeamMember } from '../tenant-embedding/tenant-embedding.access';
import { AiContext, AiService, AiStreamEvent, ChatMessage } from './ai.service';
import { AiSettingsService } from './ai-settings.service';

interface ChatBody {
  message: string;
  history?: ChatMessage[];
  context?: AiContext;
}

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /** The whole reply in one response. Kept for older dashboards; nothing is executed. */
  @Post('chat')
  chat(@CurrentUser() user: JwtPayload, @Body() body: ChatBody) {
    return this.aiService.chat(user.sub, body.message, body.history ?? [], body.context ?? {});
  }

  /**
   * The reply as server-sent events: `meta`, `status`, `delta` (text as it is
   * written), `query` (read-only results), `proposal` (a change waiting for
   * approval), then `done` or `error`. Closing the connection stops the model
   * and any query not yet started.
   */
  @Post('chat/stream')
  async stream(
    @CurrentUser() user: JwtPayload,
    @Body() body: ChatBody,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    const onClose = () => abort.abort();
    req.on('close', onClose);
    res.on('close', onClose);

    const write = (e: AiStreamEvent) => {
      if (res.writableEnded || abort.signal.aborted) return;
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      (res as any).flush?.();
    };
    // Proxies close idle streams; a comment line every 15 s keeps this one open
    // while a long query runs.
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15_000);

    try {
      await this.aiService.stream(user.sub, body ?? ({} as ChatBody), write, abort.signal);
    } catch (err: any) {
      const message = err?.response?.message ?? err?.message ?? 'The assistant failed.';
      write({ event: 'error', data: { message: Array.isArray(message) ? message.join(', ') : String(message) } });
    } finally {
      clearInterval(keepAlive);
      req.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  /** Run a read-only SQL block from the panel (refused with 422 for anything that changes data). */
  @Post('sql/run')
  @HttpCode(200)
  runReadOnly(@CurrentUser() user: JwtPayload, @Body() body: { projectId: string; sql: string }) {
    return this.aiService.runReadOnly(user.sub, body?.projectId, body?.sql);
  }

  /** Validate a SQL block that changes something and hold it for approval. */
  @Post('proposals')
  propose(@CurrentUser() user: JwtPayload, @Body() body: { projectId: string; sql: string }) {
    return this.aiService.propose(user.sub, body?.projectId, body?.sql);
  }

  /** Run a proposal the caller approved. The SQL that runs is the stored one. */
  @Post('proposals/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.aiService.approve(user.sub, id);
  }

  /** Discard a proposal without running it. */
  @Delete('proposals/:id')
  reject(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.aiService.reject(user.sub, id);
  }
}

/** The project's own model and key for the assistant. */
@Controller('projects/:projectId/ai/assistant')
@UseGuards(JwtAuthGuard)
export class AiSettingsController {
  constructor(
    private readonly settings: AiSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async get(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    await assertProjectTeamMember(this.prisma, projectId, user.sub);
    return this.settings.view(projectId);
  }

  /** Body: { provider: openai|gemini|anthropic, model?, apiKey?, skipValidation? }. The key is tested first. */
  @Put()
  async save(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
    @Body() body: { provider?: string; model?: string; apiKey?: string; skipValidation?: boolean },
  ) {
    await assertProjectTeamMember(this.prisma, projectId, user.sub);
    return this.settings.save(projectId, user.sub, body ?? {});
  }

  @Delete()
  async clear(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    await assertProjectTeamMember(this.prisma, projectId, user.sub);
    return this.settings.clear(projectId);
  }
}
