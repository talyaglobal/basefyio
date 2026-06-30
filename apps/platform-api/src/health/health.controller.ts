import { Controller, Get } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  service: 'platform-api';
  uptime: number;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatus {
    return {
      status: 'ok',
      service: 'platform-api',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
