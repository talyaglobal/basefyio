import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ManagementService } from './management.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';

/** Root-only internal plan documents (gamification, go-to-market). */
@Controller('admin/management')
@UseGuards(JwtAuthGuard, RootRoleGuard)
export class ManagementController {
  constructor(private readonly management: ManagementService) {}

  @Get('doc/:slug')
  getDoc(@Param('slug') slug: string) {
    return this.management.getDoc(slug);
  }

  @Put('doc/:slug')
  updateDoc(@Param('slug') slug: string, @Body() body: { title?: string; content: string }) {
    return this.management.updateDoc(slug, body);
  }
}
