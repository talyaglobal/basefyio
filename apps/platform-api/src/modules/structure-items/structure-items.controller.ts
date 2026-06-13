import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { StructureItemsService } from './structure-items.service';

@Controller('v1/projects/:projectId/structures/:structureId/items')
@UseGuards(JwtOrApiKeyGuard)
export class StructureItemsController {
  constructor(private readonly service: StructureItemsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.create(projectId, structureId, body);
  }

  @Get()
  async list(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.list(projectId, structureId, {
      limit: limit ? parseInt(limit, 10) : 20,
      cursor,
    });
  }

  @Get(':itemId')
  async getOne(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.get(projectId, structureId, itemId);
  }

  @Patch(':itemId')
  async update(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.update(projectId, structureId, itemId, body);
  }

  @Delete(':itemId')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.delete(projectId, structureId, itemId);
  }
}
