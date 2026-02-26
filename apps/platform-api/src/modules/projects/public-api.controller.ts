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
import { PublicApiService } from './public-api.service';
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
    const { projectId } = this.getPayload(req);
    return this.publicApi.select(projectId, table, req.query as Record<string, string>);
  }

  @Post(':table')
  async insert(
    @Param('table') table: string,
    @Body() body: Record<string, unknown> | Record<string, unknown>[],
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const { projectId, role } = this.getPayload(req);
    this.requireService(role);

    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.publicApi.insert(projectId, table, body, returnRep);
  }

  @Patch(':table')
  async update(
    @Param('table') table: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const { projectId, role } = this.getPayload(req);
    this.requireService(role);

    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.publicApi.update(projectId, table, req.query as Record<string, string>, body, returnRep);
  }

  @Delete(':table')
  async remove(
    @Param('table') table: string,
    @Req() req: Request,
    @Headers('prefer') prefer?: string,
  ) {
    const { projectId, role } = this.getPayload(req);
    this.requireService(role);

    const returnRep = prefer?.includes('return=representation') ?? false;
    return this.publicApi.delete(projectId, table, req.query as Record<string, string>, returnRep);
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }

  private requireService(role: 'anon' | 'service') {
    if (role !== 'service') {
      throw new ForbiddenException('This operation requires a service key');
    }
  }
}
