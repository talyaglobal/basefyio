import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Query,
  Headers,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { ProjectSdkAuthService } from './project-sdk-auth.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';

@Controller('rest/v1/auth')
@UseGuards(ApiKeyGuard)
export class ProjectSdkAuthController {
  constructor(private readonly sdkAuth: ProjectSdkAuthService) {}

  @Post('signup')
  async signup(
    @Req() req: Request,
    @Body() body: { email: string; password: string; firstName?: string; lastName?: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.signup(projectId, body);
  }

  @Post('signin')
  async signin(
    @Req() req: Request,
    @Body() body: { email: string; password: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.signin(projectId, body.email, body.password);
  }

  @Post('verify-email')
  async verifyEmail(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyEmail(projectId, body.otp);
  }

  @Get('verify-email-callback')
  async verifyEmailCallback(
    @Req() req: Request,
    @Query('otp') otp: string,
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyEmail(projectId, otp);
  }

  @Post('forgot-password')
  async forgotPassword(
    @Req() req: Request,
    @Body() body: { email: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.forgotPassword(projectId, body.email);
  }

  @Post('reset-password')
  async resetPassword(
    @Req() req: Request,
    @Body() body: { otp: string; newPassword: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.resetPassword(projectId, body.otp, body.newPassword);
  }

  @Post('magic-link')
  async sendMagicLink(
    @Req() req: Request,
    @Body() body: { email: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.sendMagicLink(projectId, body.email);
  }

  @Post('magic-link/verify')
  async verifyMagicLink(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyMagicLink(projectId, body.otp);
  }

  @Get('magic-link-callback')
  async magicLinkCallback(
    @Req() req: Request,
    @Query('otp') otp: string,
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyMagicLink(projectId, otp);
  }

  @Post('change-email')
  async changeEmail(
    @Req() req: Request,
    @Body() body: { newEmail: string },
    @Headers('authorization') auth?: string,
  ) {
    const { projectId } = this.getPayload(req);
    const token = auth?.replace('Bearer ', '');
    if (!token) throw new ForbiddenException('Missing Authorization header');
    return this.sdkAuth.requestChangeEmail(projectId, token, body.newEmail);
  }

  @Post('change-email/verify')
  async confirmChangeEmail(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.confirmChangeEmail(projectId, body.otp);
  }

  @Get('change-email-callback')
  async changeEmailCallback(
    @Req() req: Request,
    @Query('otp') otp: string,
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.confirmChangeEmail(projectId, otp);
  }

  @Post('reauth')
  async requestReauth(
    @Req() req: Request,
    @Headers('authorization') auth?: string,
  ) {
    const { projectId } = this.getPayload(req);
    const token = auth?.replace('Bearer ', '');
    if (!token) throw new ForbiddenException('Missing Authorization header');
    return this.sdkAuth.requestReauth(projectId, token);
  }

  @Post('reauth/verify')
  async verifyReauth(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyReauth(projectId, body.otp);
  }

  @Post('invite')
  async inviteUser(
    @Req() req: Request,
    @Body() body: { email: string },
  ) {
    const { projectId, role } = this.getPayload(req);
    if (role !== 'service') {
      throw new ForbiddenException('Invite requires service_role key');
    }
    return this.sdkAuth.inviteUser(projectId, body.email);
  }

  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Body() body: { refreshToken: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.refresh(projectId, body.refreshToken);
  }

  @Get('me')
  async me(
    @Req() req: Request,
    @Headers('authorization') auth?: string,
  ) {
    const { projectId } = this.getPayload(req);
    const token = auth?.replace('Bearer ', '');
    if (!token) throw new ForbiddenException('Missing Authorization header');
    return this.sdkAuth.me(projectId, token);
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }
}
