import {
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { FlowsService } from './flows.service';

/**
 * Public webhook ingress.
 *
 * External systems (GitHub, Stripe, custom scripts) POST to
 *   POST /webhooks/flows/:flowId
 * with the body signed using the flow's per-flow HMAC-SHA256 secret:
 *
 *   x-basefyio-signature: sha256=<hex of HMAC-SHA256(secret, raw body)>
 *
 * No API key or JWT is required — authentication is the HMAC signature.
 * The raw request body is used for signature verification; it must not be
 * transformed before it reaches this handler.
 *
 * Returns 202 on successful enqueue. 401 on missing/bad signature, 404 on
 * unknown flow, 400 on disabled or wrong trigger type. All error shapes go
 * through the global NestJS exception filter, keeping responses consistent.
 */
@Controller('webhooks/flows')
export class FlowWebhookController {
  constructor(private readonly flows: FlowsService) {}

  @Post(':flowId')
  @HttpCode(202)
  async receive(
    @Param('flowId') flowId: string,
    @Headers('x-basefyio-signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<Record<string, unknown>> {
    if (!signature) {
      throw new UnauthorizedException('Missing x-basefyio-signature header');
    }

    // NestJS wires rawBody when `rawBody: true` is set on NestFactory.create().
    // Fall back to JSON-stringified body if the raw buffer is unavailable.
    const rawBody: Buffer =
      req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? ''), 'utf8');

    // The parsed request body is forwarded as the flow run's input.
    const input: unknown = req.body ?? null;

    return this.flows.triggerViaWebhook(flowId, rawBody, signature, input);
  }
}

