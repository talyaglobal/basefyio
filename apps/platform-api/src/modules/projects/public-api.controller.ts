import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Res,
  Headers,
  HttpCode,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { PublicApiService, RlsContext } from './public-api.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';
import { contentRange, parsePrefer, toCsv, wantsCsv } from './postgrest/response';

// High-volume anonymous data API (server-to-server from the website + SDK
// clients): exempt from the global IP rate limiter so legitimate traffic from a
// single origin IP isn't throttled. Access is still gated by the API-key guard.
@SkipThrottle()
@Controller('rest/v1')
@UseGuards(ApiKeyGuard)
export class PublicApiController {
  constructor(private readonly publicApi: PublicApiService) {}

  /**
   * Read rows. The body is `{ data, count }` as it always was; `Content-Range`
   * carries the same information as a header (`0-24/3573`), and
   * `Accept: text/csv` returns the rows as CSV instead.
   */
  @Get(':table')
  async select(
    @Param('table') table: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
    @Headers('range') range?: string,
    @Headers('range-unit') rangeUnit?: string,
    @Headers('accept') accept?: string,
  ) {
    const payload = this.getPayload(req);
    const result = await this.publicApi.select(
      payload.projectId,
      table,
      req.query as Record<string, string>,
      this.buildCtx(payload),
      { count: parsePrefer(prefer).count, range, rangeUnit },
    );
    res.setHeader('Content-Range', contentRange(result.offset, result.data.length, result.count));
    if (result.countMethod) res.setHeader('Preference-Applied', `count=${result.countMethod}`);
    if (wantsCsv(accept)) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return toCsv(result.data);
    }
    return { data: result.data, count: result.count };
  }

  /**
   * Call a function: the POST body's JSON keys are its argument names.
   * Answers 200 — a call reads or computes, it does not create a resource.
   */
  @Post('rpc/:fn')
  @HttpCode(200)
  async rpc(
    @Param('fn') fn: string,
    @Body() args: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    return this.publicApi.rpc(payload.projectId, fn, args ?? {}, this.buildCtx(payload));
  }

  /**
   * Insert rows. With `Prefer: resolution=merge-duplicates` (or
   * `ignore-duplicates`) and optionally `?on_conflict=col`, an upsert.
   */
  @Post(':table')
  async insert(
    @Param('table') table: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const prefs = parsePrefer(prefer);
    const result = await this.publicApi.insert(
      payload.projectId,
      table,
      body,
      {
        returnRepresentation: prefs.return === 'representation',
        resolution: prefs.resolution,
        onConflict: req.query.on_conflict,
        select: req.query.select,
      },
      this.buildCtx(payload),
    );
    // `return=minimal` asks for no body at all.
    return prefs.return === 'minimal' ? undefined : result;
  }

  @Patch(':table')
  async update(
    @Param('table') table: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const prefs = parsePrefer(prefer);
    const result = await this.publicApi.update(
      payload.projectId,
      table,
      req.query as Record<string, string>,
      body,
      { returnRepresentation: prefs.return === 'representation', select: req.query.select },
      this.buildCtx(payload),
    );
    return this.minimal(res, prefs.return) ? undefined : result;
  }

  @Delete(':table')
  async remove(
    @Param('table') table: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const prefs = parsePrefer(prefer);
    const result = await this.publicApi.delete(
      payload.projectId,
      table,
      req.query as Record<string, string>,
      { returnRepresentation: prefs.return === 'representation', select: req.query.select },
      this.buildCtx(payload),
    );
    return this.minimal(res, prefs.return) ? undefined : result;
  }

  /** `Prefer: return=minimal` on PATCH/DELETE: 204 and no body. */
  private minimal(res: Response, preference: string | undefined): boolean {
    if (preference !== 'minimal') return false;
    res.status(204);
    return true;
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }

  private buildCtx(payload: ApiKeyPayload): RlsContext {
    return { role: payload.dbRole, jwtClaims: payload.jwtClaims };
  }
}
