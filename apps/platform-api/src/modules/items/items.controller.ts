import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ItemsService } from './items.service';
import { PolicyCompilerService } from './policy-compiler.service';
import { ItemPolicyGuard, RequireItemPermission } from './item-policy.guard';

@Controller('v1/projects/:projectId/items')
@UseGuards(JwtOrApiKeyGuard, ItemPolicyGuard)
export class ItemsController {
  constructor(
    private readonly service: ItemsService,
    private readonly policyService: PolicyCompilerService,
  ) {}

  @Post('/policy/apply')
  @HttpCode(HttpStatus.OK)
  async applyPolicies(
    @Param('projectId') projectId: string,
  ) {
    return this.policyService.applyPolicies(projectId);
  }

  @Get(':entityName')
  @RequireItemPermission('read')
  list(
    @Param('projectId') projectId: string,
    @Param('entityName') entityName: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: 'asc' | 'desc',
    @Query() query?: Record<string, string>,
    @CurrentUser() _user?: JwtPayload,
  ) {
    // Extract filter[*] params from query
    const filters: Record<string, string> = {};
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        const m = k.match(/^filter\[([^\]]+)\]$/);
        if (m) filters[m[1]] = v;
      }
    }
    return this.service.listItems(projectId, entityName, {
      filters,
      sort,
      order,
      limit: limit ? parseInt(limit, 10) : 20,
      cursor,
    });
  }

  @Get(':entityName/:id')
  @RequireItemPermission('read')
  getOne(
    @Param('projectId') projectId: string,
    @Param('entityName') entityName: string,
    @Param('id') id: string,
    @CurrentUser() _user?: JwtPayload,
  ) {
    return this.service.getItem(projectId, entityName, id);
  }

  @Post(':entityName')
  @HttpCode(HttpStatus.CREATED)
  @RequireItemPermission('write')
  create(
    @Param('projectId') projectId: string,
    @Param('entityName') entityName: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() _user?: JwtPayload,
  ) {
    return this.service.createItem(projectId, entityName, body);
  }

  @Patch(':entityName/:id')
  @RequireItemPermission('write')
  update(
    @Param('projectId') projectId: string,
    @Param('entityName') entityName: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() _user?: JwtPayload,
  ) {
    return this.service.updateItem(projectId, entityName, id, body);
  }

  @Delete(':entityName/:id')
  @HttpCode(HttpStatus.OK)
  @RequireItemPermission('delete')
  remove(
    @Param('projectId') projectId: string,
    @Param('entityName') entityName: string,
    @Param('id') id: string,
    @CurrentUser() _user?: JwtPayload,
  ) {
    return this.service.deleteItem(projectId, entityName, id);
  }
}
