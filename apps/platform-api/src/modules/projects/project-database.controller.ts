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
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ProjectDatabaseService } from './project-database.service';
import { ProjectProvisioningService } from './project-provisioning.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

@Controller('projects/:projectId/database')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class ProjectDatabaseController {
  constructor(
    private readonly db: ProjectDatabaseService,
    private readonly activity: ProjectActivityService,
    private readonly provisioning: ProjectProvisioningService,
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
  @Scopes('schema:read')
  @Get('indexes')
  listIndexes(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listIndexes(id, u.sub);
  }

  @Scopes('schema:write')
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

  @Scopes('schema:write')
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
  @Scopes('schema:read')
  @Get('triggers')
  listTriggers(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listTriggers(id, u.sub);
  }

  @Scopes('schema:write')
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

  @Scopes('schema:write')
  @Put('triggers/toggle')
  toggleTrigger(
    @Param('projectId') id: string,
    @Body() body: { name: string; table: string; enabled: boolean },
    @CurrentUser() u: JwtPayload,
  ) {
    return this.db.toggleTrigger(id, u.sub, body);
  }

  @Scopes('schema:write')
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
  @Scopes('schema:read')
  @Get('functions')
  listFunctions(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listFunctions(id, u.sub);
  }

  @Scopes('schema:write')
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

  @Scopes('schema:write')
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
  @Scopes('schema:read')
  @Get('extensions')
  listExtensions(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listExtensions(id, u.sub);
  }

  @Scopes('schema:write')
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

  /**
   * Install the default extension set (the one new projects get) into this
   * database. Idempotent; extensions already present are left alone and any
   * the cluster lacks are reported, not fatal.
   */
  @Scopes('schema:write')
  @Post('extensions/defaults')
  async installDefaultExtensions(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    const r = await this.provisioning.installDefaultExtensionsForProject(id, u.sub);
    this.log(id, u.sub, 'Default extensions installed', r.installed.join(', ') || 'none');
    return r;
  }
}
