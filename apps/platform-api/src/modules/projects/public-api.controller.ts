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
  UseGuards,
  UseFilters,
  ForbiddenException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { CompatWriteResult, PublicApiService, RlsContext } from './public-api.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';
import {
  acceptSupported,
  contentRange,
  isSupabaseCompat,
  parsePrefer,
  parseRangeHeader,
  rangeStatus,
  requestedProfile,
  wantsObject,
} from './postgrest/compat';
import { PostgrestCompatFilter } from './postgrest/compat.filter';
import { PostgrestHttpError, notAcceptableObject, postgrestBody } from './postgrest/errors';

/** Query keys of a GET rpc that are never function arguments. */
const RPC_QUERY_RESERVED = new Set(['select', 'order', 'limit', 'offset', 'apikey', 'columns', 'on_conflict']);

// High-volume anonymous data API (server-to-server from the website + SDK
// clients): exempt from the global IP rate limiter so legitimate traffic from a
// single origin IP isn't throttled. Access is still gated by the API-key guard.
//
// Two dialects are spoken here. basefyio's own SDKs get `{data, count}` and
// `{count}`; a supabase-js / postgrest-js client — recognised by its headers,
// see postgrest/compat.ts — gets PostgREST's wire format so it runs unchanged.
// The filter renders errors in whichever dialect the caller speaks.
@SkipThrottle()
@Controller('rest/v1')
@UseGuards(ApiKeyGuard)
@UseFilters(PostgrestCompatFilter)
export class PublicApiController {
  constructor(private readonly publicApi: PublicApiService) {}

  @Get(':table')
  async select(
    @Param('table') table: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
    @Headers('accept') accept?: string,
  ) {
    const payload = this.getPayload(req);
    if (!this.compat(req)) {
      return this.publicApi.select(
        payload.projectId,
        table,
        req.query as Record<string, string>,
        this.buildCtx(payload),
      );
    }

    this.assertCompatHeaders(req, accept);
    const p = parsePrefer(prefer);
    const single = wantsObject(accept);
    const head = req.method === 'HEAD';
    const r = await this.publicApi.select(
      payload.projectId,
      table,
      this.queryWithRange(req),
      this.buildCtx(payload, true),
      { count: p.count ?? null, head, wantsObject: single },
    );
    // HEAD carries no rows, so the page is the window the paging would have
    // cut out of the total; postgrest-js reads only the total anyway.
    const n = head ? this.headPageSize(req, r.total, r.offset) : r.rows.length;
    res.setHeader('Content-Range', contentRange(r.offset, n, r.total));
    res.status(single ? 200 : rangeStatus(r.offset, n, r.total));
    return single ? r.rows[0] : r.rows;
  }

  /** PostgREST-style RPC: POST body's JSON keys map to named function args. */
  @Post('rpc/:fn')
  async rpc(
    @Param('fn') fn: string,
    @Body() args: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
    @Headers('accept') accept?: string,
  ) {
    const payload = this.getPayload(req);
    if (!this.compat(req)) {
      return this.publicApi.rpc(payload.projectId, fn, args ?? {}, this.buildCtx(payload));
    }
    return this.rpcCompat(req, res, payload, fn, args ?? {}, prefer, accept);
  }

  /**
   * The same function over GET (and HEAD, which Express routes here): the
   * arguments are the query parameters. postgrest-js sends this for
   * `.rpc(fn, args, { get: true })`, meant for stable, read-only functions.
   */
  @Get('rpc/:fn')
  async rpcGet(
    @Param('fn') fn: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
    @Headers('accept') accept?: string,
  ) {
    const payload = this.getPayload(req);
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.query as Record<string, string | string[]>)) {
      if (RPC_QUERY_RESERVED.has(k)) continue;
      args[k] = Array.isArray(v) ? v[v.length - 1] : v;
    }
    if (!this.compat(req)) {
      return this.publicApi.rpc(payload.projectId, fn, args, this.buildCtx(payload));
    }
    return this.rpcCompat(req, res, payload, fn, args, prefer, accept);
  }

  private async rpcCompat(
    req: Request,
    res: Response,
    payload: ApiKeyPayload,
    fn: string,
    args: Record<string, unknown>,
    prefer?: string,
    accept?: string,
  ) {
    this.assertCompatHeaders(req, accept);
    const p = parsePrefer(prefer);
    const r = await this.publicApi.rpc(payload.projectId, fn, args, this.buildCtx(payload, true), {
      compat: true,
      prefer: p,
    });
    if (r.kind === 'void') {
      res.status(204);
      return undefined;
    }
    let value = r.value;
    if (wantsObject(accept) && r.kind === 'array') {
      const rows = r.value as unknown[];
      if (rows.length !== 1) throw notAcceptableObject(rows.length);
      value = rows[0];
    }
    res.setHeader('Content-Range', contentRange(0, r.rows, p.count ? r.rows : null));
    res.status(200);
    // Nest sends a non-object body as text; a scalar result must still be JSON.
    res.type('application/json');
    return JSON.stringify(value === undefined ? null : value);
  }

  @Post(':table')
  async insert(
    @Param('table') table: string,
    @Body() body: Record<string, unknown> | Record<string, unknown>[],
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
    @Headers('accept') accept?: string,
  ) {
    const payload = this.getPayload(req);
    if (!this.compat(req)) {
      const returnRep = prefer?.includes('return=representation') ?? false;
      return this.publicApi.insert(
        payload.projectId,
        table,
        body,
        returnRep,
        this.buildCtx(payload),
      );
    }

    this.assertCompatHeaders(req, accept);
    const r = await this.publicApi.insertCompat(
      payload.projectId,
      table,
      body,
      req.query as Record<string, string>,
      this.buildCtx(payload, true),
      { prefer: parsePrefer(prefer), wantsObject: wantsObject(accept) },
    );
    return this.replyWrite(res, r, 201, accept);
  }

  @Patch(':table')
  async update(
    @Param('table') table: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
    @Headers('accept') accept?: string,
  ) {
    const payload = this.getPayload(req);
    if (!this.compat(req)) {
      const returnRep = prefer?.includes('return=representation') ?? false;
      return this.publicApi.update(
        payload.projectId,
        table,
        req.query as Record<string, string>,
        body,
        returnRep,
        this.buildCtx(payload),
      );
    }

    this.assertCompatHeaders(req, accept);
    const r = await this.publicApi.updateCompat(
      payload.projectId,
      table,
      req.query as Record<string, string>,
      body,
      this.buildCtx(payload, true),
      { prefer: parsePrefer(prefer), wantsObject: wantsObject(accept) },
    );
    return this.replyWrite(res, r, 200, accept);
  }

  @Delete(':table')
  async remove(
    @Param('table') table: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('prefer') prefer?: string,
    @Headers('accept') accept?: string,
  ) {
    const payload = this.getPayload(req);
    if (!this.compat(req)) {
      const returnRep = prefer?.includes('return=representation') ?? false;
      return this.publicApi.delete(
        payload.projectId,
        table,
        req.query as Record<string, string>,
        returnRep,
        this.buildCtx(payload),
      );
    }

    this.assertCompatHeaders(req, accept);
    const r = await this.publicApi.deleteCompat(
      payload.projectId,
      table,
      req.query as Record<string, string>,
      this.buildCtx(payload, true),
      { prefer: parsePrefer(prefer), wantsObject: wantsObject(accept) },
    );
    return this.replyWrite(res, r, 200, accept);
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }

  private buildCtx(payload: ApiKeyPayload, compat = false): RlsContext {
    return { role: payload.dbRole, jwtClaims: payload.jwtClaims, ...(compat ? { compat } : {}) };
  }

  /**
   * PostgREST's answer to a write: 201 for POST; 200 with the rows when a
   * representation was asked for, otherwise 204 for PATCH and DELETE and an
   * empty 201 for POST. `Content-Range` carries the affected count when
   * `Prefer: count=` was sent, which is where postgrest-js reads it.
   */
  private replyWrite(res: Response, r: CompatWriteResult, okStatus: 200 | 201, accept?: string) {
    const n = r.representation ? r.rows.length : (r.total ?? 0);
    res.setHeader('Content-Range', contentRange(0, n, r.total));
    if (!r.representation) {
      res.status(okStatus === 201 ? 201 : 204);
      return undefined;
    }
    res.status(okStatus);
    return wantsObject(accept) ? r.rows[0] : r.rows;
  }

  /** The guard decided when it admitted the request; recompute if it did not. */
  private compat(req: Request): boolean {
    const decided = (req as any).supabaseCompat;
    return typeof decided === 'boolean' ? decided : isSupabaseCompat(req.headers);
  }

  /**
   * Only the `public` schema exists here, and only JSON comes out. A client
   * asking for another profile or for CSV / GeoJSON / a plan is told so with
   * PostgREST's codes instead of getting JSON it will not parse.
   */
  private assertCompatHeaders(req: Request, accept?: string): void {
    const profile = requestedProfile(req.headers, req.method);
    if (profile !== undefined && profile !== 'public') {
      throw new PostgrestHttpError(
        406,
        postgrestBody('PGRST106', 'The schema must be one of the following: public'),
      );
    }
    if (!acceptSupported(accept)) {
      throw new PostgrestHttpError(
        406,
        postgrestBody(
          'PGRST107',
          `None of these media types are available: ${accept}`,
          null,
          'Only application/json, application/vnd.pgrst.object+json and application/vnd.pgrst.array+json are served.',
        ),
      );
    }
  }

  /**
   * A `Range: 0-9` header is PostgREST's other way of paging. postgrest-js
   * uses `offset`/`limit` params, which win when both are present.
   */
  private queryWithRange(req: Request): Record<string, string> {
    const query = { ...(req.query as Record<string, string>) };
    const range = parseRangeHeader(req.headers['range'], req.headers['range-unit']);
    if (range) {
      if (query.offset === undefined) query.offset = String(range.offset);
      if (query.limit === undefined && range.limit !== undefined) query.limit = String(range.limit);
    }
    return query;
  }

  private headPageSize(req: Request, total: number | null, offset: number): number {
    if (total === null) return 0;
    const q = req.query as Record<string, string>;
    const limit = q.limit !== undefined ? parseInt(q.limit, 10) : NaN;
    const page = Number.isNaN(limit) ? 1000 : Math.min(limit, 1000);
    return Math.max(0, Math.min(page, total - offset));
  }
}
