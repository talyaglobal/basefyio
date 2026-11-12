import { Body, Controller, Get, Param, Put, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { DatabaseAccessService } from './database-access.service';
import { UpdateDbAccessDto } from './dto/update-db-access.dto';

/** Who may reach a project's database from outside, and how clients verify it. */
@Controller('projects/:projectId/database-access')
@UseGuards(JwtAuthGuard)
export class DatabaseAccessController {
  constructor(private readonly access: DatabaseAccessService) {}

  /** The rules, whether this server enforces them, TLS state and the hosts to connect to. Any member. */
  @Get()
  get(@Param('projectId') projectId: string, @CurrentUser() user: JwtPayload) {
    return this.access.get(projectId, user.sub);
  }

  /** Require TLS and/or limit the addresses that may connect. Owners and admins. */
  @Put()
  update(
    @Param('projectId') projectId: string,
    @Body() body: UpdateDbAccessDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.access.update(projectId, user.sub, body);
  }

  /** The root certificate file for `sslrootcert` (verify-full). Any member. */
  @Get('ca-certificate')
  async caCertificate(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ) {
    const file = await this.access.caCertificate(projectId, user.sub);
    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.pem);
  }
}
