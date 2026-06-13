import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { DeveloperAccessService } from './developer-access.service';
import { CertificateService } from '../certificates/certificate.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { IssueCertificateDto } from '../certificates/dto/issue-certificate.dto';
import { RevokeCertificateDto } from '../certificates/dto/revoke-certificate.dto';

@Controller('v1/projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
export class DeveloperAccessController {
  constructor(
    private readonly service: DeveloperAccessService,
    private readonly certificates: CertificateService,
  ) {}

  // ── Access info ───────────────────────────────────────────────────────────

  @Get('access')
  async getAccessInfo(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getAccessInfo(projectId, user.sub);
  }

  // ── Certificates ──────────────────────────────────────────────────────────
  // privateKeyPem is ONLY returned by issue and renew responses.
  // list/get responses never include private key material.

  @Get('access/certificate')
  async listCertificates(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.certificates.list(projectId, user.sub);
  }

  @Post('access/certificate/issue')
  async issueCertificate(
    @Param('projectId') projectId: string,
    @Body() body: IssueCertificateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.certificates.issue(projectId, user.sub, body);
  }

  @Post('access/certificate/:certId/renew')
  async renewCertificate(
    @Param('projectId') projectId: string,
    @Param('certId') certId: string,
    @Body() body: IssueCertificateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.certificates.renew(projectId, user.sub, certId, body);
  }

  @Post('access/certificate/:certId/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeCertificate(
    @Param('projectId') projectId: string,
    @Param('certId') certId: string,
    @Body() _body: RevokeCertificateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.certificates.revoke(projectId, user.sub, certId);
  }

  @Get('access/certificate/:certId/bundle')
  async getCertificateBundle(
    @Param('projectId') projectId: string,
    @Param('certId') certId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.certificates.getBundle(projectId, user.sub, certId);
  }
}
