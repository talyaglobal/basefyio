import { Body, Controller, Get, Headers, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { CapacityModelService } from './capacity-model.service';
import type { SimulationInput } from './capacity-model';

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ') || !expected) return false;
  const a = createHash('sha256').update(header.slice(7).trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

@Controller('admin/capacity')
export class CapacityController {
  constructor(private readonly model: CapacityModelService) {}

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('overview')
  overview() {
    return this.model.overview();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('model')
  async modelOnly() {
    const o = await this.model.overview();
    return { model: o.model, recommendations: o.recommendations, ceilings: o.ceilings, profile: o.profile, seedValues: o.seedValues };
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('model/history')
  history(@Query('days') days?: string) {
    return this.model.history(Number(days) || 90);
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('samples')
  samples(@Query('from') from?: string, @Query('to') to?: string, @Query('step') step?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 24 * 3_600_000);
    return this.model.samples(start, end, Number(step) || 5);
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Post('simulate')
  simulate(@Body() body: SimulationInput) {
    return this.model.simulateNow(body ?? ({} as SimulationInput));
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('recommendations')
  async recommendations() {
    return (await this.model.overview()).recommendations;
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('scenarios')
  scenarios() {
    return this.model.scenarios();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Post('scenarios')
  async saveScenario(@Body() body: { name?: string; input?: SimulationInput }) {
    await this.model.saveScenario(String(body?.name ?? ''), body?.input ?? ({} as SimulationInput));
    return { saved: true };
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('benchmarks')
  benchmarks() {
    return this.model.benchmarks();
  }

  /** A load-test runner uploads a finished run (token), or ROOT records one by hand. */
  @Post('benchmarks/results')
  async benchmarkResults(@Headers('authorization') authorization: string | undefined, @Body() body: Record<string, unknown>) {
    const expected = (process.env.CAPACITY_BENCHMARK_TOKEN || '').trim();
    if (!bearerMatches(authorization, expected)) throw new UnauthorizedException('Benchmark token required');
    return this.model.recordBenchmark(body as any);
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Post('sample')
  async sampleNow(@CurrentUser() _user: JwtPayload) {
    return this.model.sampleNow();
  }
}
