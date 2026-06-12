import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ProjectDatabaseService } from './project-database.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

@Controller('projects/:projectId/database')
@UseGuards(JwtAuthGuard)
export class ProjectDatabaseController {
  constructor(
    private readonly db: ProjectDatabaseService,
    private readonly activity: ProjectActivityService,
  ) {}

  private log(projectId: string, userId: string, title: string, detail?: string) {
    void this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title,
      detail,
    });
  }

  // Indexes
  @Get('indexes')
  listIndexes(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listIndexes(id, u.sub);
  }

  @Post('indexes')
  async createIndex(
    @Param('projectId') id: string,
    @Body() body: { table: string; columns: string[]; unique?: boolean; method?: string; name?: string },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.createIndex(id, u.sub, body);
    this.log(id, u.sub, 'Index created', `${body.table}(${body.columns.join(', ')})`);
    return r;
  }

  @Delete('indexes/:name')
  async dropIndex(
    @Param('projectId') id: string,
    @Param('name') name: string,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.dropIndex(id, u.sub, name);
    this.log(id, u.sub, 'Index dropped', name);
    return r;
  }

  // Triggers
  @Get('triggers')
  listTriggers(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listTriggers(id, u.sub);
  }

  @Post('triggers')
  async createTrigger(
    @Param('projectId') id: string,
    @Body() body: {
      name: string; table: string; timing: 'BEFORE' | 'AFTER';
      events: ('INSERT' | 'UPDATE' | 'DELETE')[]; functionName: string;
      forEach?: 'ROW' | 'STATEMENT';
    },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.createTrigger(id, u.sub, body);
    this.log(id, u.sub, 'Trigger created', `${body.name} on ${body.table}`);
    return r;
  }

  @Put('triggers/toggle')
  toggleTrigger(
    @Param('projectId') id: string,
    @Body() body: { name: string; table: string; enabled: boolean },
    @CurrentUser() u: JwtPayload,
  ) {
    return this.db.toggleTrigger(id, u.sub, body);
  }

  @Delete('triggers/:table/:name')
  async dropTrigger(
    @Param('projectId') id: string,
    @Param('table') table: string,
    @Param('name') name: string,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.dropTrigger(id, u.sub, { name, table });
    this.log(id, u.sub, 'Trigger dropped', `${name} on ${table}`);
    return r;
  }

  // Functions
  @Get('functions')
  listFunctions(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listFunctions(id, u.sub);
  }

  @Post('functions')
  async createFunction(
    @Param('projectId') id: string,
    @Body() body: { sql: string },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.createFunction(id, u.sub, body.sql);
    this.log(id, u.sub, 'Database function created');
    return r;
  }

  @Delete('functions/:name')
  async dropFunction(
    @Param('projectId') id: string,
    @Param('name') name: string,
    @Query('args') args: string | undefined,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.dropFunction(id, u.sub, name, args);
    this.log(id, u.sub, 'Database function dropped', name);
    return r;
  }

  // Extensions
  @Get('extensions')
  listExtensions(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listExtensions(id, u.sub);
  }

  @Put('extensions')
  async setExtension(
    @Param('projectId') id: string,
    @Body() body: { name: string; enabled: boolean },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.setExtension(id, u.sub, body);
    this.log(id, u.sub, `Extension ${body.enabled ? 'enabled' : 'disabled'}`, body.name);
    return r;
  }
}
