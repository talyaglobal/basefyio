import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ProvisioningCredentialRefService } from './provisioning-credential-ref.service';
import { CreateCredentialRefDto } from './dto/create-credential-ref.dto';
import { ListCredentialRefsQuery } from './dto/list-credential-refs.query';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';
import { RequireModule } from '../../common/decorators/require-module.decorator';

@Controller('v1/provisioning/credentials')
@UseGuards(JwtOrApiKeyGuard, ModuleEnabledGuard)
@UseInterceptors(AuditLogInterceptor)
@RequireModule('provisioning')
export class ProvisioningCredentialRefController {
  constructor(private readonly service: ProvisioningCredentialRefService) {}

  /**
   * Create a new credential reference (team-scoped pointer to an OpenBao path).
   * Returns 201 with the created ref.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() body: CreateCredentialRefDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.create(user.sub, body);
  }

  /**
   * List non-revoked credential refs for a team.
   * Requires teamId as a query param.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  list(
    @Query() query: ListCredentialRefsQuery,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.list(user.sub, query.teamId);
  }

  /**
   * Revoke a credential ref by ID (soft-delete — sets revokedAt).
   * Returns 204 on success, 404 if not found, 409 if already revoked.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.revoke(user.sub, id);
  }
}
