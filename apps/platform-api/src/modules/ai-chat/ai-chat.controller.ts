import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { AiChatService, ChatMessageInput } from './ai-chat.service';

/**
 * The signed-in person's own assistant history.
 *
 * Every route takes the user id from the verified token and never from the
 * request, so there is no parameter a caller could change to read someone
 * else's conversation. The service repeats that filter in its WHERE clauses
 * rather than trusting this layer — the id in the path is a claim, not proof.
 */
@Controller('ai/chat')
@UseGuards(JwtAuthGuard)
export class AiChatController {
  constructor(private readonly chat: AiChatService) {}

  @Get('sessions')
  async listSessions(@CurrentUser() user: JwtPayload, @Query('teamId') teamId: string) {
    if (!teamId) throw new BadRequestException('teamId is required');
    return this.chat.listSessions(user.sub, teamId);
  }

  @Post('sessions')
  async createSession(
    @CurrentUser() user: JwtPayload,
    @Body() body: { teamId?: string; projectId?: string; title?: string },
  ) {
    if (!body?.teamId) throw new BadRequestException('teamId is required');
    return this.chat.createSession(user.sub, body.teamId, body.projectId, body.title);
  }

  @Get('sessions/:id')
  async getSession(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chat.getSession(user.sub, id);
  }

  @Post('sessions/:id/messages')
  async appendMessages(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() body: { messages?: ChatMessageInput[] },
  ) {
    if (!Array.isArray(body?.messages)) throw new BadRequestException('messages must be an array');
    return this.chat.appendMessages(user.sub, id, body.messages);
  }

  @Delete('sessions/:id')
  async deleteSession(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.chat.deleteSession(user.sub, id);
  }

  @Delete('sessions')
  async clearAll(@CurrentUser() user: JwtPayload, @Query('teamId') teamId: string) {
    if (!teamId) throw new BadRequestException('teamId is required');
    return this.chat.clearAll(user.sub, teamId);
  }
}
