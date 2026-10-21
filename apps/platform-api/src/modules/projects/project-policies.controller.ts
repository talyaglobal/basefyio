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
import {
  MutationOpts,
  PolicyMutationResult,
  ProjectPoliciesService,
} from './project-policies.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

type MutationBody = Record<string, unknown> & { dryRun?: unknown; check?: unknown };

function optsFrom(body: MutationBody | undefined): MutationOpts {
  return { dryRun: body?.dryRun === true, check: body?.check === true };
}

function flag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * Row-level security policies of a project database. Dashboard sessions only
 * (team membership is checked by the service); API keys never reach these.
 */
@Controller('projects/:projectId/database/policies')
@UseGuards(JwtAuthGuard)
export class ProjectPoliciesController {
  constructor(
    private readonly policies: ProjectPoliciesService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** Dry runs and checks change nothing, so only applied changes are logged. */
  private log(
    projectId: string,
    userId: string,
    result: PolicyMutationResult,
    title: string,
    detail: string,
  ) {
    if (!result.applied) return;
    void this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title,
      detail,
    });
  }

  @Get()
  list(@Param('projectId') id: string, @CurrentUser() u: JwtPayload) {
    return this.policies.listPolicies(id, u.sub);
  }

  @Post()
  async create(
    @Param('projectId') id: string,
    @Body() body: MutationBody,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.policies.createPolicy(id, u.sub, body, optsFrom(body));
    this.log(id, u.sub, r, 'Policy created', `${body?.table}.${body?.name}`);
    return r;
  }

  @Post('rls')
  async setRls(
    @Param('projectId') id: string,
    @Body() body: MutationBody,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.policies.setRowLevelSecurity(id, u.sub, body, optsFrom(body));
    const state = body?.enabled === true ? 'enabled' : 'disabled';
    this.log(id, u.sub, r, `Row-level security ${state}`, String(body?.table));
    return r;
  }

  @Put(':table/:name')
  async replace(
    @Param('projectId') id: string,
    @Param('table') table: string,
    @Param('name') name: string,
    @Body() body: MutationBody,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.policies.replacePolicy(id, u.sub, table, name, body, optsFrom(body));
    this.log(id, u.sub, r, 'Policy updated', `${table}.${name}`);
    return r;
  }

  @Delete(':table/:name')
  async drop(
    @Param('projectId') id: string,
    @Param('table') table: string,
    @Param('name') name: string,
    @Query('dryRun') dryRun: string | undefined,
    @Query('check') check: string | undefined,
    @CurrentUser() u: JwtPayload,
  ) {
    const r = await this.policies.dropPolicy(id, u.sub, table, name, {
      dryRun: flag(dryRun),
      check: flag(check),
    });
    this.log(id, u.sub, r, 'Policy dropped', `${table}.${name}`);
    return r;
  }
}
