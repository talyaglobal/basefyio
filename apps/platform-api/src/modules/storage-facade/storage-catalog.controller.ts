import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { StorageService } from '../storage/storage.service';
import { StorageCatalogBackfillService } from './storage-catalog-backfill.service';

/**
 * Operator routes for the storage catalog behind the Supabase-compatible
 * facade: which authorisation mode a project runs, and a full rebuild of the
 * catalog from the object store. Service key or a dashboard team member.
 */
@Controller('projects/:projectId/storage')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class StorageCatalogController {
  constructor(
    private readonly storage: StorageService,
    private readonly backfill: StorageCatalogBackfillService,
  ) {}

  @Get('catalog')
  async status(@Param('projectId') projectId: string, @CurrentUser() user?: JwtPayload) {
    await this.storage.resolveProject(projectId, user?.sub);
    return this.backfill.status(projectId);
  }

  @Post('catalog/backfill')
  async run(@Param('projectId') projectId: string, @CurrentUser() user?: JwtPayload) {
    await this.storage.resolveProject(projectId, user?.sub);
    return this.backfill.backfill(projectId);
  }

  @Patch('authz')
  async setMode(
    @Param('projectId') projectId: string,
    @Body() body: { mode?: unknown },
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.storage.resolveProject(projectId, user?.sub);
    return this.backfill.setMode(projectId, body?.mode);
  }
}
