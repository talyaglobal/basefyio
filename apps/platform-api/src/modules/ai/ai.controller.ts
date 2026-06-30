import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { AiService } from './ai.service';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('chat')
  chat(
    @CurrentUser() user: JwtPayload,
    @Body()
    body: {
      message: string;
      history?: { role: 'user' | 'assistant'; content: string }[];
      context?: {
        projectId?: string;
        projectName?: string;
        tables?: string[];
        page?: string;
        allProjects?: { id: string; name: string }[];
        mode?: 'ask' | 'plan' | 'agent';
      };
    },
  ) {
    return this.aiService.chat(
      user.sub,
      body.message,
      body.history ?? [],
      body.context ?? {},
    );
  }
}
