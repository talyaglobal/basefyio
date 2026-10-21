import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtOrPlatformTokenGuard } from '../../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../../api-tokens/scopes.guard';
import { Scopes } from '../../api-tokens/scopes.decorator';
import { CurrentUser, JwtPayload } from '../../../common/decorators/current-user.decorator';
import { ProjectBranchService } from './project-branch.service';
import { CreatePreviewBranchDto } from './dto/create-preview-branch.dto';

/** Preview branches of a project: child projects populated from the parent's database. */
@Controller('projects/:id/branches')
@UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
export class ProjectBranchesController {
  constructor(private readonly branches: ProjectBranchService) {}

  @Post()
  @Scopes('projects:write')
  async create(
    @Param('id') id: string,
    @Body() dto: CreatePreviewBranchDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.branches.createPreviewBranch(id, user.sub, dto);
  }

  @Get()
  @Scopes('projects:read')
  async list(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.branches.listPreviewBranches(id, user.sub);
  }

  @Delete(':branchId')
  @Scopes('projects:write')
  async remove(
    @Param('id') id: string,
    @Param('branchId') branchId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.branches.deletePreviewBranch(id, branchId, user.sub);
  }
}
