import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { issueStreamTicket, isStreamPath } from '../../common/auth/stream-ticket';

/**
 * Mints the single-use ticket a browser EventSource uses instead of putting
 * the access token in the stream URL (see common/auth/stream-ticket.ts).
 */
@Controller('auth')
export class StreamTicketController {
  @Post('stream-ticket')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  mint(@Body() body: { path?: string }, @CurrentUser() user: JwtPayload) {
    const path = typeof body?.path === 'string' ? body.path.split('?')[0] : '';
    if (!isStreamPath(path)) {
      throw new BadRequestException(
        'path must be an event-stream route such as /api/realtime/stream or /api/projects/:id/export/jobs/:jobId/events',
      );
    }
    return issueStreamTicket(user, path);
  }
}
