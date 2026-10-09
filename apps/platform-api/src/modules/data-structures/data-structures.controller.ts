import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DataStructuresService } from './data-structures.service';
import { CreateDataStructureDto } from './dto/create-data-structure.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

/**
 * Data structure definitions.
  *
  * Creating a structure is DDL. These handlers take a non-optional current user
  * and dereference it, so a key-authed call fails today with a 500 — a crash,
  * not a decision. Stating the requirement turns that into a 403 that says why.
 */
@Controller('v1/projects/:projectId/structures')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
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
