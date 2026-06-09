import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { DataStructuresService } from './data-structures.service';
import { CreateDataStructureDto } from './dto/create-data-structure.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';

@Controller('v1/projects/:projectId/structures')
@UseGuards(JwtOrApiKeyGuard)
@UseInterceptors(AuditLogInterceptor)
export class DataStructuresController {
  constructor(private readonly service: DataStructuresService) {}

  /** Unified Data Explorer — lists all SQL + JSON structures for a project. */
  @Get()
  async list(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.list(projectId);
  }

  /**
   * Create a data structure.
   * Body: { name, kind: "relational" | "json" }
   * The internal jsonBackend is chosen by the platform — never accepted from clients.
   */
  @Post()
  async create(
    @Param('projectId') projectId: string,
    @Body() body: CreateDataStructureDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.create(projectId, body);
  }
}
