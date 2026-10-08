import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { SqlService } from './sql.service';
import { ExecuteSqlDto } from './dto/execute-sql.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ApiKeyPayload } from '../../common/guards/api-key.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@Controller('sql')
@UseGuards(JwtOrApiKeyGuard)
export class SqlController {
  constructor(private readonly sqlService: SqlService) {}

  @Post('execute')
  async execute(
    @Body() dto: ExecuteSqlDto,
    @Req() req: Request & { apiKeyPayload?: ApiKeyPayload },
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
    });
  }
}
