import { Controller, Get } from '@nestjs/common';

/** Lightweight, unauthenticated liveness probe for Traefik / Docker health. */
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
