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
import { ProjectProvisioningService } from './project-provisioning.service';
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

  // Schemas
  @Get('schemas')
  listSchemas(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listSchemas(id, u.sub);
  }

  @Post('schemas')
  async createSchema(
    @Param('projectId') id: string,
    @Body() body: { name: string },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.createSchema(id, u.sub, body);
    this.log(id, u.sub, 'Schema created', body.name);
    return r;
  }

  @Delete('schemas/:name')
  async dropSchema(
    @Param('projectId') id: string,
    @Param('name') name: string,
    @Query('cascade') cascade: string | undefined,
    @CurrentUser() u: JwtPayload,
  ) {
    const withCascade = cascade === 'true' || cascade === '1';
    const r = await this.db.dropSchema(id, u.sub, name, withCascade);
    this.log(id, u.sub, 'Schema dropped', withCascade ? `${name} (cascade)` : name);
    return r;
  }

  // Columns (read-only, every table in the project's schemas)
  @Get('columns')
  listColumns(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listColumns(id, u.sub);
  }

  // Roles (read-only)
  @Get('roles')
  listRoles(
    @Param('projectId') id: string,
    @Query('system') system: string | undefined,
    @CurrentUser() u: JwtPayload,
  ) {
    return this.db.listRoles(id, u.sub, { includeSystem: system === 'true' || system === '1' });
  }

  // Enums
  @Get('enums')
  listEnums(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listEnums(id, u.sub);
  }

  @Post('enums')
  async createEnum(
    @Param('projectId') id: string,
    @Body() body: { schema?: string; name: string; values: string[] },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.createEnum(id, u.sub, body);
    this.log(id, u.sub, 'Enum created', `${body.schema || 'public'}.${body.name}`);
    return r;
  }

  @Post('enums/:schema/:name/values')
  async addEnumValue(
    @Param('projectId') id: string,
    @Param('schema') schema: string,
    @Param('name') name: string,
    @Body() body: { value: string; before?: string; after?: string },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.addEnumValue(id, u.sub, schema, name, body);
    this.log(id, u.sub, 'Enum value added', `${schema}.${name}: ${body.value}`);
    return r;
  }

  @Delete('enums/:schema/:name')
  async dropEnum(
    @Param('projectId') id: string,
    @Param('schema') schema: string,
    @Param('name') name: string,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.dropEnum(id, u.sub, schema, name);
    this.log(id, u.sub, 'Enum dropped', `${schema}.${name}`);
    return r;
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
      forEach?: 'ROW' | 'STATEMENT'; functionSchema?: string;
    },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.createTrigger(id, u.sub, body);
    this.log(id, u.sub, 'Trigger created', `${body.name} on ${body.table}`);
    return r;
  }

  /** Functions a trigger can execute (return `trigger`, no declared arguments). */
  @Get('trigger-functions')
  listTriggerFunctions(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.db.listTriggerFunctions(id, u.sub);
  }

  @Put('triggers/toggle')
  async toggleTrigger(
    @Param('projectId') id: string,
    @Body() body: { name: string; table: string; enabled: boolean },
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.db.toggleTrigger(id, u.sub, body);
    this.log(id, u.sub, `Trigger ${body.enabled ? 'enabled' : 'disabled'}`, `${body.name} on ${body.table}`);
    return r;
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

  /**
   * Install the default extension set (the one new projects get) into this
   * database. Idempotent; extensions already present are left alone and any
   * the cluster lacks are reported, not fatal.
   */
  @Post('extensions/defaults')
  async installDefaultExtensions(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    const r = await this.provisioning.installDefaultExtensionsForProject(id, u.sub);
    this.log(id, u.sub, 'Default extensions installed', r.installed.join(', ') || 'none');
    return r;
  }
}
