import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageAccessService } from './storage-access.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { ProjectActivityKind, ProjectActivityService } from '../projects/project-activity.service';

/**
 * Access rules for buckets and prefixes. Administration only: the service key
 * or a signed-in team member. The rules themselves are enforced by
 * StorageController on download, render, list, delete and upload.
 */
@Controller('projects/:projectId/storage')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
export class StoragePolicyController {
  constructor(
    private readonly storage: StorageService,
    private readonly access: StorageAccessService,
    private readonly activity: ProjectActivityService,
  ) {}

  @Get('policies')
  async list(@Param('projectId') projectId: string, @CurrentUser() user?: JwtPayload) {
    await this.storage.resolveProject(projectId, user?.sub);
    return this.access.listPolicies(projectId);
  }

  @Put('buckets/:bucketName/policy')
  async set(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Body() body: { mode: string; pathPrefix?: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const { minioBucket } = await this.storage.resolveBucket(projectId, user?.sub, bucketName);
    if (await this.storage.bucketIsPublic(minioBucket)) {
      throw new BadRequestException(
        'Make the bucket private first. A public bucket is readable at its direct storage URL regardless of access rules.',
      );
    }
    const policy = await this.access.setPolicy(projectId, bucketName, body ?? {}, user?.sub);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.STORAGE_BUCKET_UPDATED,
      title: `Storage access rule set: ${bucketName}`,
      detail: `${policy.mode}${policy.pathPrefix ? ` (prefix "${policy.pathPrefix}")` : ''}`,
    });
    return policy;
  }

  @Delete('buckets/:bucketName/policy')
  async remove(
    @Param('projectId') projectId: string,
    @Param('bucketName') bucketName: string,
    @Query('pathPrefix') pathPrefix: string | undefined,
    @CurrentUser() user?: JwtPayload,
  ): Promise<{ removed: number }> {
    await this.storage.resolveProject(projectId, user?.sub);
    const removed = await this.access.removePolicy(projectId, bucketName, pathPrefix ?? '');
    if (removed > 0) {
      await this.activity.append(projectId, {
        userId: user?.sub,
        kind: ProjectActivityKind.STORAGE_BUCKET_UPDATED,
        title: `Storage access rule removed: ${bucketName}`,
        detail: pathPrefix ? `prefix "${pathPrefix}"` : 'whole bucket',
      });
    }
    return { removed };
  }
}
