import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AiService } from './ai.service';

@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('chat')
  chat(
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
      body.message,
      body.history ?? [],
      body.context ?? {},
    );
  }
}
