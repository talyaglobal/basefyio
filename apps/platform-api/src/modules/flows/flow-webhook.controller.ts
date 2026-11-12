import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  RawBodyRequest,
} from '@nestjs/common';
import { Request } from 'express';
import { FlowsService } from './flows.service';

/**
 * A flow's own webhook URL: `POST /api/hooks/flows/:webhookId`.
 *
 * Deliberately outside the project API guards — the point is that GitHub,
 * Stripe or any other system can start the flow WITHOUT holding the project's
 * service key. The caller proves the flow's own secret instead (header or
 * body signature, see flow-webhook-auth.ts); the secret is never accepted in
 * the URL, which proxies and access logs record.
 *
 * Answers 202 with the run id once the run is queued.
 */
@Controller('hooks/flows')
export class FlowWebhookController {
  constructor(private readonly flows: FlowsService) {}

  @Post(':webhookId')
  @HttpCode(202)
  receive(
    @Param('webhookId') webhookId: string,
    @Req() req: RawBodyRequest<Request>,
    @Body() body: unknown,
    @Query() query: Record<string, unknown>,
  ) {
    return this.flows.receiveWebhook(webhookId, {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: req.rawBody,
      body,
      query,
    });
  }
}
