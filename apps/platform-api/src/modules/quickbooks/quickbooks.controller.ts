import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { QuickbooksService } from './quickbooks.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';

@Controller('admin/quickbooks')
export class QuickbooksController {
  constructor(
    private readonly quickbooks: QuickbooksService,
    private readonly config: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('status')
  async status() {
    return this.quickbooks.getStatus();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('dashboard')
  async dashboard() {
    return this.quickbooks.getDashboard();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Post('test')
  async test() {
    return this.quickbooks.createTestSalesReceipt();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('authorize-url')
  async authorizeUrl(@Req() req: any) {
    const url = await this.quickbooks.getAuthorizeUrl(req.user?.sub);
    return { url };
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Patch('settings')
  async settings(@Body() body: { autoCreate: boolean }) {
    return this.quickbooks.setAutoCreate(body.autoCreate !== false);
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Post('disconnect')
  async disconnect() {
    return this.quickbooks.disconnect();
  }

  /**
   * OAuth redirect target (registered in the Intuit app). Public — it's a
   * top-level browser redirect from Intuit — and validated via the signed state.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('realmId') realmId: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const appUrl = this.config.get<string>('appUrl') || 'http://localhost:3000';
    const dest = `${appUrl}/dashboard/management`;
    try {
      if (error) return res.redirect(`${dest}?qb=error&reason=${encodeURIComponent(error)}`);
      if (!code || !realmId || !state) return res.redirect(`${dest}?qb=error&reason=missing_params`);
      await this.quickbooks.handleCallback(code, realmId, state);
      return res.redirect(`${dest}?qb=connected`);
    } catch (err: any) {
      return res.redirect(`${dest}?qb=error&reason=${encodeURIComponent(err.message || 'failed')}`);
    }
  }
}
