import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ProjectDataService } from './project-data.service';
import { ProjectsService } from './projects.service';
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

@Controller('projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(AuditLogInterceptor)
export class ProjectDataController {
  constructor(
    private readonly dataService: ProjectDataService,
    private readonly projectsService: ProjectsService,
    private readonly activity: ProjectActivityService,
  ) {}

  @Get('tables')
  async listTables(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataService.listTables(projectId, user?.sub);
  }

  @Get('tables/:tableName/columns')
  async getColumns(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataService.getColumns(projectId, user?.sub, tableName);
  }

  @Get('tables/:tableName/rows')
  async getRows(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @CurrentUser() user: JwtPayload | undefined,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.dataService.getRows(projectId, user?.sub, tableName, page, limit);
  }

  @Post('tables')
  async createTable(
    @Param('projectId') projectId: string,
    @Body() body: {
      name: string;
      columns: { name: string; type: string; nullable: boolean; isPrimary: boolean; defaultValue?: string }[];
    },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.createTable(projectId, user?.sub, body.name, body.columns);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_CREATED,
      title: `Table created: ${body.name}`,
      detail: `${body.columns.length} columns`,
    });
    return result;
  }

  @Post('tables/:tableName/rows')
  async insertRow(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    const row = await this.dataService.insertRow(projectId, user?.sub, tableName, body);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_ROW_INSERTED,
      title: `Row inserted: ${tableName}`,
      detail: `${Object.keys(body).length} field(s)`,
    });
    return row;
  }

  @Put('tables/:tableName/rows')
  async updateRow(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: { pkWhere: Record<string, unknown>; data: Record<string, unknown> },
    @CurrentUser() user?: JwtPayload,
  ) {
    const row = await this.dataService.updateRow(projectId, user?.sub, tableName, body.pkWhere, body.data);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_ROW_UPDATED,
      title: `Row updated: ${tableName}`,
      detail: `PK: ${JSON.stringify(body.pkWhere)} | Changed: ${Object.keys(body.data || {}).length} field(s)`,
    });
    return row;
  }

  @Delete('tables/:tableName/rows')
  async deleteRow(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: { pkWhere: Record<string, unknown> },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.deleteRow(projectId, user?.sub, tableName, body.pkWhere);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_ROW_DELETED,
      title: `Row deleted: ${tableName}`,
      detail: `PK: ${JSON.stringify(body.pkWhere)}`,
    });
    return result;
  }

  @Delete('tables/:tableName')
  async dropTable(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.dropTable(projectId, user?.sub, tableName);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_DROPPED,
      title: `Table dropped: ${tableName}`,
    });
    return result;
  }

  @Post('tables/:tableName/columns')
  async addColumn(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: { name: string; type: string; nullable: boolean; defaultValue?: string; isUnique?: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.addColumn(projectId, user?.sub, tableName, body);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_COLUMN_ADDED,
      title: `Column added: ${tableName}.${body.name}`,
    });
    return result;
  }

  @Put('tables/:tableName/columns/:columnName')
  async editColumn(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Param('columnName') columnName: string,
    @Body() body: { name?: string; type?: string; nullable?: boolean; defaultValue?: string | null; isUnique?: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.editColumn(projectId, user?.sub, tableName, columnName, body);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_COLUMN_UPDATED,
      title: `Column updated: ${tableName}.${columnName}`,
      detail: Object.keys(body).join(', '),
    });
    return result;
  }

  @Delete('tables/:tableName/columns/:columnName')
  async deleteColumn(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Param('columnName') columnName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.deleteColumn(projectId, user?.sub, tableName, columnName);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_COLUMN_DELETED,
      title: `Column deleted: ${tableName}.${columnName}`,
    });
    return result;
  }

  @Get('tables/:tableName/foreign-keys')
  async getForeignKeys(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataService.getForeignKeys(projectId, user?.sub, tableName);
  }

  @Post('tables/:tableName/foreign-keys')
  async addForeignKey(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: { columnName: string; foreignTableName: string; foreignColumnName: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.addForeignKey(projectId, user?.sub, tableName, body);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_FK_ADDED,
      title: `Foreign key added: ${tableName}.${body.columnName}`,
      detail: `-> ${body.foreignTableName}.${body.foreignColumnName}`,
    });
    return result;
  }

  @Delete('tables/:tableName/foreign-keys/:constraintName')
  async deleteForeignKey(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Param('constraintName') constraintName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const result = await this.dataService.deleteForeignKey(projectId, user?.sub, tableName, constraintName);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.TABLE_FK_DELETED,
      title: `Foreign key removed: ${tableName}`,
      detail: constraintName,
    });
    return result;
  }

  @Get('connect')
  async getConnectionStrings(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.dataService.getConnectionStrings(project);
  }
}
