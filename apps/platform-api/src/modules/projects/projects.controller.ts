import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';

@Controller('projects')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AuditLogInterceptor)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  async create(
    @Body() dto: CreateProjectDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.create(dto, user.sub);
  }

  @Get()
  async findAll(@CurrentUser() user: JwtPayload) {
    return this.projectsService.findAll(user.sub);
  }

  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.findOne(id, user.sub);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.projectsService.remove(id, user.sub);
  }
}
