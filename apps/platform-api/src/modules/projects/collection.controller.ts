import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { CollectionService } from './collection.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

@Controller('projects/:projectId/collections')
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(AuditLogInterceptor)
export class CollectionController {
  constructor(
    private readonly collectionService: CollectionService,
    private readonly activity: ProjectActivityService,
  ) {}

  @Get()
  async listCollections(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.collectionService.listCollections(projectId, user?.sub);
  }

  @Post()
  async createCollection(
    @Param('projectId') projectId: string,
    @Body() body: { name: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.collectionService.createCollection(
      projectId,
      body.name,
      user?.sub,
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.COLLECTION_CREATED,
      title: `Collection created: ${body.name}`,
    });
    return result;
  }

  @Delete(':collectionName')
  async dropCollection(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.collectionService.dropCollection(
      projectId,
      collectionName,
      user?.sub,
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.COLLECTION_DROPPED,
      title: `Collection dropped: ${collectionName}`,
    });
    return result;
  }

  /* ─────────────── Documents ─────────────── */

  @Get(':collectionName/documents')
  async findDocuments(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Query('filter') filterRaw?: string,
    @Query('sort') sortRaw?: string,
    @Query('project') projectRaw?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
    @CurrentUser() user?: JwtPayload,
  ) {
    const filter = filterRaw ? JSON.parse(filterRaw) : undefined;
    const sort = sortRaw ? JSON.parse(sortRaw) : undefined;
    const project = projectRaw ? JSON.parse(projectRaw) : undefined;

    return this.collectionService.findDocuments(
      projectId,
      collectionName,
      { filter, sort, project, limit, offset },
      user?.sub,
    );
  }

  @Post(':collectionName/documents')
  async insertDocuments(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Body() body: Record<string, unknown> | Record<string, unknown>[],
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.collectionService.insertDocument(
      projectId,
      collectionName,
      body,
      user?.sub,
    );
    const count = Array.isArray(body) ? body.length : 1;
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.COLLECTION_DOCUMENT_INSERTED,
      title: `Document(s) inserted: ${collectionName}`,
      detail: `${count} document(s)`,
    });
    return result;
  }

  @Get(':collectionName/documents/:docId')
  async getDocument(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Param('docId') docId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.collectionService.findDocumentById(
      projectId,
      collectionName,
      docId,
      user?.sub,
    );
  }

  @Patch(':collectionName/documents/:docId')
  async updateDocument(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Param('docId') docId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.collectionService.updateDocument(
      projectId,
      collectionName,
      docId,
      body,
      user?.sub,
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.COLLECTION_DOCUMENT_UPDATED,
      title: `Document updated: ${collectionName}`,
      detail: `id: ${docId}`,
    });
    return result;
  }

  @Put(':collectionName/documents/:docId')
  async replaceDocument(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Param('docId') docId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.collectionService.replaceDocument(
      projectId,
      collectionName,
      docId,
      body,
      user?.sub,
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.COLLECTION_DOCUMENT_REPLACED,
      title: `Document replaced: ${collectionName}`,
      detail: `id: ${docId}`,
    });
    return result;
  }

  @Delete(':collectionName/documents/:docId')
  async deleteDocument(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Param('docId') docId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.collectionService.deleteDocument(
      projectId,
      collectionName,
      docId,
      user?.sub,
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.COLLECTION_DOCUMENT_DELETED,
      title: `Document deleted: ${collectionName}`,
      detail: `id: ${docId}`,
    });
    return result;
  }

  @Delete(':collectionName/documents')
  async bulkDeleteDocuments(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Body() body: { filter: Record<string, unknown> },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.collectionService.deleteDocuments(
      projectId,
      collectionName,
      body.filter,
      user?.sub,
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.COLLECTION_DOCUMENT_DELETED,
      title: `Bulk delete: ${collectionName}`,
      detail: `${result.deleted} document(s) deleted`,
    });
    return result;
  }

  /* ─────────────── Count & Index ─────────────── */

  @Get(':collectionName/count')
  async countDocuments(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Query('filter') filterRaw?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const filter = filterRaw ? JSON.parse(filterRaw) : undefined;
    return this.collectionService.countDocuments(
      projectId,
      collectionName,
      filter,
      user?.sub,
    );
  }

  @Post(':collectionName/indexes')
  async createIndex(
    @Param('projectId') projectId: string,
    @Param('collectionName') collectionName: string,
    @Body() body: { fieldPath: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.collectionService.createIndex(
      projectId,
      collectionName,
      body.fieldPath,
      user?.sub,
    );
  }
}
