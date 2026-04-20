import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Headers,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { PublicApiService, RlsContext } from './public-api.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';

@Controller('rest/v1')
@UseGuards(ApiKeyGuard)
export class PublicApiController {
  constructor(private readonly publicApi: PublicApiService) {}

  @Get(':table')
  async select(
    @Param('table') table: string,
    @Req() req: Request,
  ) {
    const payload = this.getPayload(req);
    return this.publicApi.select(
      payload.projectId,
      table,
      req.query as Record<string, string>,
      this.buildCtx(payload),
    );
  }

  @Post(':table')
  async insert(
    @Param('table') table: string,
    @Body() body: Record<string, unknown> | Record<string, unknown>[],
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.publicApi.insert(
      payload.projectId,
      table,
      body,
      returnRep,
      this.buildCtx(payload),
    );
  }

  @Patch(':table')
  async update(
    @Param('table') table: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
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

  @Delete(':table')
  async remove(
    @Param('table') table: string,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const payload = this.getPayload(req);
    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.publicApi.delete(
      payload.projectId,
      table,
      req.query as Record<string, string>,
      returnRep,
      this.buildCtx(payload),
    );
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
