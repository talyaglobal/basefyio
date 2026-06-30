import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ManagementService } from './management.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';

/** Root-only internal boards (gamification roadmap, go-to-market plan). */
@Controller('admin/management')
@UseGuards(JwtAuthGuard, RootRoleGuard)
export class ManagementController {
  constructor(private readonly management: ManagementService) {}

  @Get('checklist/:board')
  getBoard(@Param('board') board: string) {
    return this.management.getBoard(board);
  }

  @Post('checklist/:board')
  addItem(
    @Param('board') board: string,
    @Body() body: { section?: string; title: string; detail?: string; position?: number },
  ) {
    return this.management.addItem(board, body);
  }

  @Patch('checklist/:board/:id')
  updateItem(
    @Param('board') board: string,
    @Param('id') id: string,
    @Body() body: { status?: string; notes?: string; title?: string; detail?: string; section?: string; position?: number },
  ) {
    return this.management.updateItem(board, id, body);
  }

  @Delete('checklist/:board/:id')
  deleteItem(@Param('board') board: string, @Param('id') id: string) {
    return this.management.deleteItem(board, id);
  }
}
