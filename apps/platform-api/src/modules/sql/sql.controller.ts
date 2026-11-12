import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { SqlService } from './sql.service';
import {
  CancelSqlDto,
  CreateSqlSnippetDto,
  ExecuteSqlDto,
  UpdateSqlSnippetDto,
} from './dto/execute-sql.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ApiKeyPayload } from '../../common/guards/api-key.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

type SqlRequest = Request & { apiKeyPayload?: ApiKeyPayload };

@Controller('sql')
@UseGuards(JwtOrApiKeyGuard)
export class SqlController {
  constructor(private readonly sqlService: SqlService) {}

  @Post('execute')
  async execute(
    @Body() dto: ExecuteSqlDto,
    @Req() req: SqlRequest,
    @CurrentUser() user?: JwtPayload,
  ) {
    // An API-key call must run under the key's database role so RLS applies;
    // the public anon key can then read what policy allows and write nothing.
    // A dashboard team member (JWT, no apiKeyPayload) keeps owner access — the
    // SQL editor — by leaving rls undefined.
    const key = req.apiKeyPayload;
    const rls = key
      ? { role: key.dbRole, jwtClaims: key.jwtClaims }
      : undefined;

    return this.sqlService.execute(dto.projectId, dto.query, user?.sub, {
      page: dto.page,
      limit: dto.limit,
      countTotal: dto.countTotal,
      params: dto.params,
      rls,
      readOnly: dto.readOnly,
      maxRows: dto.maxRows,
      compact: dto.compact,
      runId: dto.runId,
    });
  }

  /** Cancel a statement this user started in the SQL editor (by its runId). */
  @Post('cancel')
  cancel(@Body() dto: CancelSqlDto, @Req() req: SqlRequest, @CurrentUser() user?: JwtPayload) {
    return this.sqlService.cancel(dto.projectId, dto.runId, this.dashboardUser(req, user));
  }

  /** The signed-in user's recent statements in a project (from the SQL audit log). */
  @Get('history')
  history(
    @Query('projectId') projectId: string,
    @Query('limit') limit: string | undefined,
    @Req() req: SqlRequest,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.sqlService.history(projectId, this.dashboardUser(req, user), Number(limit) || 50);
  }

  // ── Saved queries, shared with the project's team ─────────────────────────

  @Get('snippets')
  listSnippets(
    @Query('projectId') projectId: string,
    @Req() req: SqlRequest,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.sqlService.listSnippets(projectId, this.dashboardUser(req, user));
  }

  @Post('snippets')
  createSnippet(@Body() dto: CreateSqlSnippetDto, @Req() req: SqlRequest, @CurrentUser() user?: JwtPayload) {
    return this.sqlService.createSnippet(dto.projectId, this.dashboardUser(req, user), dto);
  }

  @Put('snippets/:id')
  updateSnippet(
    @Param('id') id: string,
    @Body() dto: UpdateSqlSnippetDto,
    @Req() req: SqlRequest,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.sqlService.updateSnippet(id, this.dashboardUser(req, user), dto);
  }

  @Delete('snippets/:id')
  deleteSnippet(@Param('id') id: string, @Req() req: SqlRequest, @CurrentUser() user?: JwtPayload) {
    return this.sqlService.deleteSnippet(id, this.dashboardUser(req, user));
  }

  /**
   * Saved queries, history and cancel belong to a person in the dashboard;
   * a project key has no person behind it.
   */
  private dashboardUser(req: SqlRequest, user?: JwtPayload): string {
    if (req.apiKeyPayload || !user?.sub) {
      throw new ForbiddenException('This endpoint needs a dashboard session');
    }
    return user.sub;
  }
}
