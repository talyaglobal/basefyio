import {
  Controller,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SqlService } from './sql.service';
import { ExecuteSqlDto } from './dto/execute-sql.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { AuditLogInterceptor } from '../../common/interceptors/audit-log.interceptor';

@Controller('sql')
@UseGuards(JwtAuthGuard)
@UseInterceptors(AuditLogInterceptor)
export class SqlController {
  constructor(private readonly sqlService: SqlService) {}

  @Post('execute')
  async execute(
    @Body() dto: ExecuteSqlDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.sqlService.execute(dto.projectId, dto.query, user.sub);
  }
}
