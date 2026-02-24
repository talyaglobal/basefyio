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

@Controller('projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(AuditLogInterceptor)
export class ProjectDataController {
  constructor(
    private readonly dataService: ProjectDataService,
    private readonly projectsService: ProjectsService,
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
    return this.dataService.createTable(projectId, user?.sub, body.name, body.columns);
  }

  @Post('tables/:tableName/rows')
  async insertRow(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataService.insertRow(projectId, user?.sub, tableName, body);
  }

  @Put('tables/:tableName/rows')
  async updateRow(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: { pkWhere: Record<string, unknown>; data: Record<string, unknown> },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataService.updateRow(projectId, user?.sub, tableName, body.pkWhere, body.data);
  }

  @Delete('tables/:tableName/rows')
  async deleteRow(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @Body() body: { pkWhere: Record<string, unknown> },
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataService.deleteRow(projectId, user?.sub, tableName, body.pkWhere);
  }

  @Delete('tables/:tableName')
  async dropTable(
    @Param('projectId') projectId: string,
    @Param('tableName') tableName: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.dataService.dropTable(projectId, user?.sub, tableName);
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
