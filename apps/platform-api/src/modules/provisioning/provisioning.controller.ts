import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { CreateProvisioningProjectDto } from './dto/create-provisioning-project.dto';
import { CreateProvisioningOperationDto } from './dto/create-provisioning-operation.dto';
import { ListResourcesQuery } from './dto/list-resources.query';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';
import { RequireModule } from '../../common/decorators/require-module.decorator';

@Controller('v1/provisioning')
@UseGuards(JwtOrApiKeyGuard, ModuleEnabledGuard)
@UseInterceptors(AuditLogInterceptor)
@RequireModule('provisioning')
export class ProvisioningController {
  constructor(
    private readonly service: ProvisioningService,
    private readonly executor: ProvisioningExecutorService,
  ) {}

  @Post('projects')
  @HttpCode(HttpStatus.CREATED)
  createProject(
    @Body() body: CreateProvisioningProjectDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.createProject(user.sub, body);
  }

  /**
   * Create a provisioning operation.
   *
   * Idempotency: if a request arrives with a previously-seen idempotencyKey for the
   * same provisioningProjectId, the existing operation is returned with HTTP 200 and
   * `idempotent: true` in the body — no duplicate is created and no audit event is written.
   *
   * dryRun is required — there is no server-side default. Passing `dryRun: true`
   * immediately moves the operation to DRY_RUN status; no executor is queued.
   */
  @Post('operations')
  @HttpCode(HttpStatus.CREATED)
  async createOperation(
    @Body() body: CreateProvisioningOperationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const result = await this.service.createOperation(user.sub, body);
    // Return 200 on idempotent replay so callers can distinguish new vs existing
    return result;
  }

  @Get('operations/:id')
  getOperation(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getOperation(user.sub, id);
  }

  @Get('resources')
  listResources(
    @Query() query: ListResourcesQuery,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.listResources(
      user.sub,
      query.projectId,
      query.includeDestroyed ?? false,
    );
  }

  /**
   * Execute a PENDING operation synchronously.
   *
   * Only PENDING operations may be executed.
   * RUNNING / COMPLETED / FAILED / DRY_RUN / ROLLED_BACK all return 400.
   * Execution path: PENDING → RUNNING → COMPLETED (success) | FAILED (error).
   * Each transition is recorded as an audit event.
   * The provider receives only the OpenBao path reference — never credential bytes.
   */
  @Post('operations/:id/execute')
  @HttpCode(HttpStatus.OK)
  executeOperation(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.executor.executeOperation(user.sub, id);
  }
}
