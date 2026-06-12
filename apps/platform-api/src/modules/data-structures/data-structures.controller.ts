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
  UseGuards,
} from '@nestjs/common';
import { DataStructuresService } from './data-structures.service';
import { CreateDataStructureDto } from './dto/create-data-structure.dto';
import { UpdateDataStructureDto } from './dto/update-data-structure.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

@Controller('v1/projects/:projectId/structures')
@UseGuards(JwtOrApiKeyGuard)
export class DataStructuresController {
  constructor(private readonly service: DataStructuresService) {}

  @Get()
  async list(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.list(projectId);
  }

  @Get(':structureId')
  async get(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.get(projectId, structureId);
  }

  @Post()
  async create(
    @Param('projectId') projectId: string,
    @Body() body: CreateDataStructureDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.create(projectId, body);
  }

  @Patch(':structureId')
  async update(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @Body() body: UpdateDataStructureDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    return this.service.update(projectId, structureId, body);
  }

  @Delete(':structureId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @Param('projectId') projectId: string,
    @Param('structureId') structureId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.assertProjectMember(projectId, user.sub);
    await this.service.delete(projectId, structureId);
  }
}
