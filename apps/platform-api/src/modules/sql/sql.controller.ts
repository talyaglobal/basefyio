import {
  Controller,
  Post,
  Body,
  UseGuards,
} from '@nestjs/common';
import { SqlService } from './sql.service';
import { ExecuteSqlDto } from './dto/execute-sql.dto';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
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
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.sqlService.execute(dto.projectId, dto.query, user?.sub, {
      page: dto.page,
      limit: dto.limit,
      countTotal: dto.countTotal,
    });
  }
}
