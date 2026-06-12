import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, Headers, HttpCode, HttpStatus,
} from '@nestjs/common';
import { SupabaseCompatService } from './supabase-compat.service';

@Controller('rest/v1')
export class SupabaseCompatController {
  constructor(private readonly service: SupabaseCompatService) {}

  @Get(':table')
  select(
    @Param('table') table: string,
    @Query() query: Record<string, string>,
    @Headers('x-project-id') projectId: string,
  ) {
    if (!projectId) return [];
    return this.service.select(projectId, table, query);
  }

  @Post(':table')
  @HttpCode(HttpStatus.CREATED)
  insert(
    @Param('table') table: string,
    @Body() body: unknown,
    @Headers('x-project-id') projectId: string,
  ) {
    if (!projectId) return [];
    return this.service.insert(projectId, table, body);
  }

  @Patch(':table')
  update(
    @Param('table') table: string,
    @Query() query: Record<string, string>,
    @Body() body: Record<string, unknown>,
    @Headers('x-project-id') projectId: string,
  ) {
    if (!projectId) return [];
    return this.service.update(projectId, table, query, body);
  }

  @Delete(':table')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('table') table: string,
    @Query() query: Record<string, string>,
    @Headers('x-project-id') projectId: string,
  ) {
    if (!projectId) return [];
    return this.service.delete(projectId, table, query);
  }
}
